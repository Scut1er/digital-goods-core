import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import type { IssueError, IssueRequest, IssueSuccess } from '../types.js';

export type ProviderName = 'A' | 'B';

export class ProviderTimeoutError extends Error {
  constructor(public readonly provider: ProviderName, public readonly requestId: string) {
    super(`Provider ${provider} timeout for ${requestId}`);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly reason: string,
    public readonly httpStatus: number,
  ) {
    super(`Provider ${provider} error: ${reason}`);
    this.name = 'ProviderHttpError';
  }
}

type ProviderRates = { failRate: number; timeoutRate: number };

/**
 * Stub providers share the same inventory_keys pool.
 * Idempotency: same request_id always returns the same code (DB unique on request_id).
 * Timeout trap: we may allocate a key THEN sleep past client timeout — retry must hit provider_issue_log.
 */
async function allocateKey(
  client: PoolClient,
  provider: ProviderName,
  req: IssueRequest,
): Promise<string> {
  const existing = await client.query(
    `SELECT code FROM provider_issue_log WHERE request_id = $1`,
    [req.request_id],
  );
  if (existing.rowCount) {
    return existing.rows[0].code as string;
  }

  // Also check if this request_id already reserved a key
  const reserved = await client.query(
    `SELECT code FROM inventory_keys WHERE request_id = $1`,
    [req.request_id],
  );
  if (reserved.rowCount) {
    const code = reserved.rows[0].code as string;
    await client.query(
      `INSERT INTO provider_issue_log (request_id, provider, sku, order_id, code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id) DO NOTHING`,
      [req.request_id, provider, req.sku, req.order_id, code],
    );
    return code;
  }

  const key = await client.query(
    `SELECT id, code FROM inventory_keys
     WHERE sku = $1 AND status = 'available'
     ORDER BY id
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [req.sku],
  );

  if (key.rowCount === 0) {
    throw new ProviderHttpError(provider, 'out_of_stock', 409);
  }

  const { id, code } = key.rows[0] as { id: string; code: string };

  await client.query(
    `UPDATE inventory_keys
     SET status = 'sold', order_id = $2, request_id = $3, sold_at = now()
     WHERE id = $1`,
    [id, req.order_id, req.request_id],
  );

  await client.query(
    `INSERT INTO provider_issue_log (request_id, provider, sku, order_id, code)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id) DO NOTHING`,
    [req.request_id, provider, req.sku, req.order_id, code],
  );

  return code;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function issueWithChaos(
  provider: ProviderName,
  rates: ProviderRates,
  req: IssueRequest,
  opts?: { forceTimeoutAfterIssue?: boolean; forceFail?: boolean; disableChaos?: boolean },
): Promise<IssueSuccess> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent fast-path before chaos (retries after real issue must succeed cleanly)
    const prior = await client.query(`SELECT code FROM provider_issue_log WHERE request_id = $1`, [
      req.request_id,
    ]);
    if (prior.rowCount) {
      await client.query('COMMIT');
      return { status: 'ok', request_id: req.request_id, code: prior.rows[0].code as string };
    }

    if (!opts?.disableChaos) {
      const roll = Math.random();
      if (opts?.forceFail || roll < rates.failRate) {
        await client.query('ROLLBACK');
        throw new ProviderHttpError(provider, 'upstream_unavailable', 503);
      }
    }

    const code = await allocateKey(client, provider, req);
    await client.query('COMMIT');

    // Timeout AFTER successful issue — classic trap: code issued, response never arrives.
    const timeoutRoll = Math.random();
    if (
      opts?.forceTimeoutAfterIssue ||
      (!opts?.disableChaos && timeoutRoll < rates.timeoutRate)
    ) {
      await sleep(config.providerTimeoutMs + 500);
      throw new ProviderTimeoutError(provider, req.request_id);
    }

    return { status: 'ok', request_id: req.request_id, code };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function callProvider(
  provider: ProviderName,
  req: IssueRequest,
  opts?: { forceTimeoutAfterIssue?: boolean; forceFail?: boolean; disableChaos?: boolean },
): Promise<IssueSuccess> {
  const rates = provider === 'A' ? config.providerA : config.providerB;

  const work = issueWithChaos(provider, rates, req, opts);

  // Client-side timeout: if provider hangs, abort wait — but DB commit may already have happened.
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTimeoutError(provider, req.request_id)),
      config.providerTimeoutMs,
    );
  });

  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    // Prevent unhandled rejection if work loses the race but later throws/resolves.
    void work.catch(() => undefined);
  }
}

/** HTTP-shaped handlers for optional external probing of stubs. */
export async function providerIssueHandler(
  provider: ProviderName,
  body: IssueRequest,
): Promise<{ statusCode: number; body: IssueSuccess | IssueError }> {
  try {
    const ok = await callProvider(provider, body);
    return { statusCode: 200, body: ok };
  } catch (err) {
    if (err instanceof ProviderTimeoutError) {
      // Simulate hang: caller already timed out; if reached via HTTP, delay then 504
      await sleep(100);
      return { statusCode: 504, body: { status: 'error', reason: 'timeout' } };
    }
    if (err instanceof ProviderHttpError) {
      return {
        statusCode: err.httpStatus,
        body: { status: 'error', reason: err.reason },
      };
    }
    throw err;
  }
}
