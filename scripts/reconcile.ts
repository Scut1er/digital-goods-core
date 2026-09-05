import { reconcile } from '../src/services/reconcile.js';
import { pool } from '../src/db/pool.js';

async function main() {
  const report = await reconcile();
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  if (!report.ledger.consistent) process.exit(2);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
