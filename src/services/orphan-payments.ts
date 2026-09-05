import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../db/pool.js';
import { handlePaymentWebhook } from './orders.js';
import type { PaymentWebhook } from '../types.js';

/**
 * Re-drive payment events that arrived before the order row existed.
 * event_id uniqueness means handlePaymentWebhook will see them as duplicates
 * if we call it naively — so we apply via a dedicated path that marks applied.
 */
export async function applyOrphanPaymentEvents(log: FastifyBaseLogger) {
  const orphans = await pool.query(
    `SELECT pe.event_id, pe.payload, o.id AS order_exists
     FROM payment_events pe
     LEFT JOIN orders o ON o.id = pe.order_id
     WHERE pe.applied = FALSE
     ORDER BY pe.received_at ASC
     LIMIT 50`,
  );

  for (const row of orphans.rows) {
    if (!row.order_exists) continue;
    const payload = row.payload as PaymentWebhook;

    // Mark unapplied → delete unique conflict by temporarily removing and re-processing
    // Safer: apply inline without re-insert.
    await pool.query(`DELETE FROM payment_events WHERE event_id = $1 AND applied = FALSE`, [
      row.event_id,
    ]);
    try {
      await handlePaymentWebhook(payload, log);
    } catch (err) {
      log.error({ err, event_id: row.event_id }, 'orphan.apply_failed');
      // Restore orphan for next tick
      await pool.query(
        `INSERT INTO payment_events (event_id, order_id, status, amount, currency, payload, created_at, applied)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          payload.event_id,
          payload.order_id,
          payload.status,
          payload.amount,
          payload.currency,
          JSON.stringify(payload),
          payload.created_at ?? null,
        ],
      );
    }
  }
}
