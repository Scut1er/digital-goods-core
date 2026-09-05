import { pool, withTx } from '../db/pool.js';
import type { Order } from '../types.js';

function mapOrder(row: Record<string, unknown>): Order {
  return row as unknown as Order;
}

/** Atomically claim stuck orders for recovery (SKIP LOCKED). */
export async function claimStuckOrders(limit = 10): Promise<string[]> {
  return withTx(async (client) => {
    const res = await client.query(
      `SELECT id FROM orders
       WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
         AND delivery_code IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY updated_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const ids = res.rows.map((r) => r.id as string);
    if (ids.length) {
      await client.query(
        `UPDATE orders SET next_attempt_at = now() + interval '60 seconds', updated_at = now()
         WHERE id = ANY($1::text[])`,
        [ids],
      );
    }
    return ids;
  });
}

export async function getOrderRow(id: string): Promise<Order | null> {
  const r = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return r.rowCount ? mapOrder(r.rows[0]) : null;
}
