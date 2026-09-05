import { pool } from '../db/pool.js';

export type ReconcileReport = {
  paid_not_delivered: Array<{
    id: string;
    status: string;
    amount: number;
    sku: string;
    paid_at: string | null;
    last_error: string | null;
  }>;
  delivered_not_paid: Array<{
    id: string;
    status: string;
    amount: number;
    sku: string;
    delivered_at: string | null;
  }>;
  ledger: {
    balance: number;
    payment_in_sum: number;
    entry_count: number;
    consistent: boolean;
  };
  orphan_payment_events: number;
};

export async function reconcile(): Promise<ReconcileReport> {
  const paidNotDelivered = await pool.query(
    `SELECT id, status, amount, sku, paid_at, last_error
     FROM orders
     WHERE paid_at IS NOT NULL
       AND delivery_code IS NULL
       AND status NOT IN ('payment_failed')
     ORDER BY paid_at ASC`,
  );

  const deliveredNotPaid = await pool.query(
    `SELECT id, status, amount, sku, delivered_at
     FROM orders
     WHERE delivery_code IS NOT NULL
       AND paid_at IS NULL
     ORDER BY delivered_at ASC`,
  );

  const ledger = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0)::BIGINT AS balance,
       COALESCE(SUM(amount) FILTER (WHERE entry_type = 'payment_in'), 0)::BIGINT AS payment_in_sum,
       COUNT(*)::INT AS entry_count
     FROM ledger_entries`,
  );

  const orphans = await pool.query(
    `SELECT COUNT(*)::INT AS c FROM payment_events WHERE applied = FALSE`,
  );

  const balance = Number(ledger.rows[0].balance);
  const paymentIn = Number(ledger.rows[0].payment_in_sum);

  // Consistency check: every delivered paid order has payment_in; balance == sum(payment_in)
  // (delivery_cost entries are 0 in this stub).
  const inconsistent = await pool.query(
    `SELECT o.id
     FROM orders o
     WHERE o.paid_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries le
         WHERE le.order_id = o.id AND le.entry_type = 'payment_in'
       )
     LIMIT 5`,
  );

  return {
    paid_not_delivered: paidNotDelivered.rows.map((r) => ({
      id: r.id,
      status: r.status,
      amount: r.amount,
      sku: r.sku,
      paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      last_error: r.last_error,
    })),
    delivered_not_paid: deliveredNotPaid.rows.map((r) => ({
      id: r.id,
      status: r.status,
      amount: r.amount,
      sku: r.sku,
      delivered_at: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
    })),
    ledger: {
      balance,
      payment_in_sum: paymentIn,
      entry_count: ledger.rows[0].entry_count,
      consistent: balance === paymentIn && inconsistent.rowCount === 0,
    },
    orphan_payment_events: orphans.rows[0].c,
  };
}
