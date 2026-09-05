/**
 * Provider timeout trap: force issue-then-timeout, retry same request_id → same code.
 * Usage: npm run test:timeout
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { callProvider, ProviderTimeoutError } from '../src/services/providers.js';

async function main() {
  // Ensure we have a product + key
  const sku = 'KEY-CS2-PRIME';
  const orderId = `ord_timeout_${Date.now()}`;
  const requestId = `${orderId}-issue-A`;

  let timedOut = false;
  try {
    await callProvider(
      'A',
      { request_id: requestId, sku, order_id: orderId },
      { forceTimeoutAfterIssue: true, disableChaos: true },
    );
  } catch (err) {
    if (err instanceof ProviderTimeoutError) timedOut = true;
    else throw err;
  }

  if (!timedOut) {
    console.error('FAIL: expected timeout after issue');
    process.exit(1);
  }

  // Key must already be allocated under this request_id
  const issued = await pool.query(`SELECT code FROM provider_issue_log WHERE request_id = $1`, [
    requestId,
  ]);
  if (!issued.rowCount) {
    console.error('FAIL: provider did not persist code on timeout path');
    process.exit(1);
  }
  const code1 = issued.rows[0].code as string;

  // Retry — must return same code, no second allocation
  const ok = await callProvider(
    'A',
    { request_id: requestId, sku, order_id: orderId },
    { disableChaos: true },
  );
  if (ok.code !== code1) {
    console.error('FAIL: retry returned different code', ok.code, code1);
    process.exit(1);
  }

  const count = await pool.query(
    `SELECT COUNT(*)::INT AS c FROM inventory_keys WHERE request_id = $1`,
    [requestId],
  );
  if (count.rows[0].c !== 1) {
    console.error('FAIL: expected exactly 1 key for request_id, got', count.rows[0].c);
    process.exit(1);
  }

  console.log('PASS: timeout trap — same request_id → same code, no double issue');
  console.log({ requestId, code: code1 });
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
