import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { pool, withTx } from '../db/pool.js';
import type { Order } from '../types.js';
import {
  callProvider,
  ProviderHttpError,
  ProviderTimeoutError,
  type ProviderName,
} from './providers.js';

function mapOrder(row: Record<string, unknown>): Order {
  return row as unknown as Order;
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
}

function requestIdFor(orderId: string, provider: ProviderName): string {
  // Stable per (order, provider). Retries keep the same id → timeout ≠ double issue.
  return `${orderId}-issue-${provider}`;
}

/**
 * Exactly-once delivery orchestration:
 * 1. Lock order FOR UPDATE
 * 2. If already delivered → no-op
 * 3. Try provider A with stable request_id; on timeout RETRY same id (never allocate new)
 * 4. On definitive A failure → fallback B with its own stable request_id
 * 5. Persist code once; unique indexes guard doubles
 */
export async function enqueueDelivery(orderId: string, log: FastifyBaseLogger): Promise<void> {
  await deliverOrder(orderId, log);
}

export async function deliverOrder(orderId: string, log: FastifyBaseLogger): Promise<Order | null> {
  // Claim order for delivery
  const claimed = await withTx(async (client) => {
    const res = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (res.rowCount === 0) return null;
    const order = mapOrder(res.rows[0]);

    if (order.status === 'delivered') return order;
    if (order.status === 'payment_failed' || order.status === 'created') return order;

    if (!['paid', 'delivering', 'out_of_stock', 'delivery_failed'].includes(order.status)) {
      return order;
    }

    const upd = await client.query(
      `UPDATE orders
       SET status = 'delivering',
           updated_at = now(),
           version = version + 1,
           next_attempt_at = NULL
       WHERE id = $1
         AND status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
       RETURNING *`,
      [orderId],
    );
    return upd.rowCount ? mapOrder(upd.rows[0]) : order;
  });

  if (!claimed || claimed.status === 'delivered' || claimed.status === 'created' || claimed.status === 'payment_failed') {
    return claimed;
  }

  // Prefer continuing with the provider already recorded (recovery after timeout).
  const providers: ProviderName[] =
    claimed.provider === 'B' ? ['B'] : claimed.provider === 'A' ? ['A', 'B'] : ['A', 'B'];

  let lastError = 'unknown';

  for (const provider of providers) {
    const requestId = requestIdFor(orderId, provider);
    let attempt = 0;

    while (attempt < config.providerMaxRetries) {
      attempt += 1;
      const started = Date.now();
      try {
        // Persist active request_id before call so recovery uses the same id after timeout.
        await pool.query(
          `UPDATE orders SET request_id = $2, provider = $3, attempt_count = attempt_count + 1, updated_at = now()
           WHERE id = $1 AND status = 'delivering' AND delivery_code IS NULL`,
          [orderId, requestId, provider],
        );

        const result = await callProvider(provider, {
          request_id: requestId,
          sku: claimed.sku,
          order_id: orderId,
        });

        const latency = Date.now() - started;
        await pool.query(
          `INSERT INTO delivery_attempts (order_id, provider, request_id, outcome, http_status, code, latency_ms)
           VALUES ($1, $2, $3, 'ok', 200, $4, $5)`,
          [orderId, provider, requestId, result.code, latency],
        );

        const finalized = await withTx(async (client) => {
          const locked = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [
            orderId,
          ]);
          const order = mapOrder(locked.rows[0]);
          if (order.status === 'delivered' && order.delivery_code) {
            return order;
          }

          const upd = await client.query(
            `UPDATE orders
             SET status = 'delivered',
                 delivery_code = $2,
                 provider = $3,
                 request_id = $4,
                 delivered_at = now(),
                 last_error = NULL,
                 updated_at = now(),
                 version = version + 1
             WHERE id = $1 AND delivery_code IS NULL
             RETURNING *`,
            [orderId, result.code, provider, requestId],
          );

          if (upd.rowCount === 0) {
            const again = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
            return mapOrder(again.rows[0]);
          }

          await client.query(
            `INSERT INTO ledger_entries (order_id, entry_type, amount, currency, description)
             VALUES ($1, 'delivery_cost', 0, $2, $3)`,
            [orderId, order.currency, `Delivered via provider ${provider} code=${result.code}`],
          );

          return mapOrder(upd.rows[0]);
        });

        log.info(
          { order_id: orderId, provider, request_id: requestId, code: result.code },
          'delivery.success',
        );
        return finalized;
      } catch (err) {
        const latency = Date.now() - started;

        if (err instanceof ProviderTimeoutError) {
          lastError = 'timeout';
          await pool.query(
            `INSERT INTO delivery_attempts (order_id, provider, request_id, outcome, http_status, error_reason, latency_ms)
             VALUES ($1, $2, $3, 'timeout', 504, 'timeout', $4)`,
            [orderId, provider, requestId, latency],
          );

          // Timeout ≠ failure: provider may have issued. Bind late code before any fallback.
          const late = await findIssuedCode(requestId);
          if (late) {
            log.warn({ order_id: orderId, provider, request_id: requestId, code: late }, 'delivery.timeout_recovered');
            return finalizeWithCode(orderId, provider, requestId, late, log);
          }

          log.warn(
            { order_id: orderId, provider, request_id: requestId, attempt },
            'delivery.timeout_retry_same_request_id',
          );
          await sleep(backoffMs(attempt));
          continue;
        }

        if (err instanceof ProviderHttpError) {
          lastError = err.reason;
          await pool.query(
            `INSERT INTO delivery_attempts (order_id, provider, request_id, outcome, http_status, error_reason, latency_ms)
             VALUES ($1, $2, $3, 'error', $4, $5, $6)`,
            [orderId, provider, requestId, err.httpStatus, err.reason, latency],
          );

          if (err.reason === 'out_of_stock') {
            await pool.query(
              `UPDATE orders
               SET status = 'out_of_stock', last_error = $2, next_attempt_at = now() + interval '30 seconds',
                   updated_at = now(), version = version + 1
               WHERE id = $1 AND status = 'delivering'`,
              [orderId, err.reason],
            );
            log.warn({ order_id: orderId, provider }, 'delivery.out_of_stock');
            return getOrder(orderId);
          }

          log.warn(
            { order_id: orderId, provider, reason: err.reason, attempt },
            'delivery.provider_error',
          );
          await sleep(backoffMs(attempt));
          // After retries exhausted on this provider → try fallback (outer loop).
          if (attempt >= config.providerMaxRetries) break;
          continue;
        }

        lastError = err instanceof Error ? err.message : 'unknown';
        log.error({ err, order_id: orderId }, 'delivery.unexpected');
        break;
      }
    }
    const late = await findIssuedCode(requestId);
    if (late) {
      return finalizeWithCode(orderId, provider, requestId, late, log);
    }
  }

  await pool.query(
    `UPDATE orders
     SET status = 'delivery_failed',
         last_error = $2,
         next_attempt_at = now() + interval '15 seconds',
         updated_at = now(),
         version = version + 1
     WHERE id = $1 AND status = 'delivering' AND delivery_code IS NULL`,
    [orderId, lastError],
  );
  log.error({ order_id: orderId, lastError }, 'delivery.failed');
  return getOrder(orderId);
}

async function getOrder(id: string): Promise<Order | null> {
  const r = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return r.rowCount ? mapOrder(r.rows[0]) : null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findIssuedCode(requestId: string): Promise<string | null> {
  const r = await pool.query(`SELECT code FROM provider_issue_log WHERE request_id = $1`, [
    requestId,
  ]);
  return r.rowCount ? (r.rows[0].code as string) : null;
}

async function finalizeWithCode(
  orderId: string,
  provider: ProviderName,
  requestId: string,
  code: string,
  log: FastifyBaseLogger,
): Promise<Order | null> {
  const finalized = await withTx(async (client) => {
    const locked = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = mapOrder(locked.rows[0]);
    if (order.status === 'delivered' && order.delivery_code) return order;

    const upd = await client.query(
      `UPDATE orders
       SET status = 'delivered',
           delivery_code = $2,
           provider = $3,
           request_id = $4,
           delivered_at = now(),
           last_error = NULL,
           updated_at = now(),
           version = version + 1
       WHERE id = $1 AND delivery_code IS NULL
       RETURNING *`,
      [orderId, code, provider, requestId],
    );
    if (upd.rowCount === 0) {
      const again = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
      return mapOrder(again.rows[0]);
    }
    await client.query(
      `INSERT INTO ledger_entries (order_id, entry_type, amount, currency, description)
       VALUES ($1, 'delivery_cost', 0, $2, $3)`,
      [orderId, order.currency, `Delivered via provider ${provider} code=${code}`],
    );
    return mapOrder(upd.rows[0]);
  });
  log.info({ order_id: orderId, provider, request_id: requestId, code }, 'delivery.success');
  return finalized;
}

/** Background recovery: safely finish stuck paid/delivering/failed/oos orders. */
export async function recoverStuckOrders(log: FastifyBaseLogger, limit = 10): Promise<number> {
  const { claimStuckOrders } = await import('./claim.js');
  const ids = await claimStuckOrders(limit);
  let n = 0;
  for (const id of ids) {
    await deliverOrder(id, log);
    n += 1;
  }
  return n;
}
