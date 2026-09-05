import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { pool, withTx, type TxClient } from '../db/pool.js';
import type { Order, PaymentWebhook } from '../types.js';
import { enqueueDelivery } from './delivery.js';

function mapOrder(row: Record<string, unknown>): Order {
  return row as unknown as Order;
}

export async function createOrder(sku: string): Promise<Order> {
  const product = await pool.query(
    `SELECT sku, price, currency FROM products WHERE sku = $1 AND active = TRUE`,
    [sku],
  );
  if (product.rowCount === 0) {
    const err = new Error('SKU_NOT_FOUND') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  const id = `ord_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const { price, currency } = product.rows[0] as { price: number; currency: string };

  const inserted = await pool.query(
    `INSERT INTO orders (id, sku, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'created')
     RETURNING *`,
    [id, sku, price, currency],
  );
  return mapOrder(inserted.rows[0]);
}

/** Create order with a predetermined id (used when applying early webhooks in tests). */
export async function createOrderWithId(id: string, sku: string): Promise<Order> {
  const product = await pool.query(
    `SELECT sku, price, currency FROM products WHERE sku = $1 AND active = TRUE`,
    [sku],
  );
  if (product.rowCount === 0) {
    const err = new Error('SKU_NOT_FOUND') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  const { price, currency } = product.rows[0] as { price: number; currency: string };
  const inserted = await pool.query(
    `INSERT INTO orders (id, sku, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'created')
     RETURNING *`,
    [id, sku, price, currency],
  );
  return mapOrder(inserted.rows[0]);
}

export async function getOrder(id: string): Promise<Order | null> {
  const r = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return r.rowCount ? mapOrder(r.rows[0]) : null;
}

/**
 * Idempotent payment webhook handler.
 * - Unique event_id → duplicates are no-ops (200).
 * - Order row locked with FOR UPDATE to serialize parallel paid events.
 * - Out-of-order / early webhooks: event stored (applied=false), 200; worker/create applies later.
 * - Exactly one transition created→paid and one delivery enqueue.
 */
export async function handlePaymentWebhook(
  payload: PaymentWebhook,
  log: FastifyBaseLogger,
): Promise<{ duplicate: boolean; order: Order | null }> {
  return withTx(async (client) => {
    const existing = await client.query(
      `SELECT event_id, applied FROM payment_events WHERE event_id = $1`,
      [payload.event_id],
    );
    if ((existing.rowCount ?? 0) > 0) {
      log.info({ event_id: payload.event_id, order_id: payload.order_id }, 'payment.webhook.duplicate');
      const order = await client.query(`SELECT * FROM orders WHERE id = $1`, [payload.order_id]);
      return {
        duplicate: true,
        order: order.rowCount ? mapOrder(order.rows[0]) : null,
      };
    }

    const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [
      payload.order_id,
    ]);
    if (orderRes.rowCount === 0) {
      // Out-of-order: webhook arrived before order. Store orphan, ack 200; apply on create/reconcile.
      await client.query(
        `INSERT INTO payment_events (event_id, order_id, status, amount, currency, payload, created_at, applied)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
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
      log.warn({ event_id: payload.event_id, order_id: payload.order_id }, 'payment.webhook.order_missing_stored');
      return { duplicate: false, order: null };
    }

    const order = mapOrder(orderRes.rows[0]);

    const inserted = await client.query(
      `INSERT INTO payment_events (event_id, order_id, status, amount, currency, payload, created_at, applied)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, TRUE)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
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
    if (inserted.rowCount === 0) {
      log.info({ event_id: payload.event_id, order_id: payload.order_id }, 'payment.webhook.duplicate_race');
      return { duplicate: true, order };
    }

    if (payload.status === 'failed') {
      if (order.status === 'created') {
        const updated = await client.query(
          `UPDATE orders SET status = 'payment_failed', updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'created'
           RETURNING *`,
          [order.id],
        );
        await client.query(
          `INSERT INTO ledger_entries (order_id, entry_type, amount, currency, description)
           VALUES ($1, 'payment_failed', 0, $2, $3)`,
          [order.id, order.currency, `Payment failed event ${payload.event_id}`],
        );
        log.info({ order_id: order.id, event_id: payload.event_id }, 'payment.failed');
        return { duplicate: false, order: mapOrder(updated.rows[0]) };
      }
      // Already past created — ignore failed (out of order after paid).
      log.info({ order_id: order.id, status: order.status }, 'payment.failed.ignored');
      return { duplicate: false, order };
    }

    // status === paid
    if (order.status !== 'created') {
      // Already paid / delivering / delivered / failed terminal — idempotent.
      log.info(
        { order_id: order.id, status: order.status, event_id: payload.event_id },
        'payment.paid.already_processed',
      );
      return { duplicate: false, order };
    }

    if (payload.amount !== order.amount || payload.currency !== order.currency) {
      log.warn(
        { order_id: order.id, expected: order.amount, got: payload.amount },
        'payment.amount_mismatch',
      );
      // Still accept but record; business choice: reject. We reject transition.
      const err = new Error('AMOUNT_MISMATCH') as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    }

    const requestId = `${order.id}-issue`;
    const updated = await client.query(
      `UPDATE orders
       SET status = 'paid',
           paid_at = now(),
           request_id = $2,
           next_attempt_at = now(),
           updated_at = now(),
           version = version + 1
       WHERE id = $1 AND status = 'created'
       RETURNING *`,
      [order.id, requestId],
    );

    if (updated.rowCount === 0) {
      // Race: another txn won — re-read
      const again = await client.query(`SELECT * FROM orders WHERE id = $1`, [order.id]);
      return { duplicate: false, order: mapOrder(again.rows[0]) };
    }

    await client.query(
      `INSERT INTO ledger_entries (order_id, entry_type, amount, currency, description)
       VALUES ($1, 'payment_in', $2, $3, $4)`,
      [order.id, order.amount, order.currency, `Payment ${payload.event_id}`],
    );

    log.info({ order_id: order.id, event_id: payload.event_id, amount: order.amount }, 'payment.paid');

    // Delivery runs after commit via caller — mark for immediate pickup.
    return { duplicate: false, order: mapOrder(updated.rows[0]) };
  }).then(async (result) => {
    if (result.order?.status === 'paid') {
      // Fire-and-forget delivery kick; worker is backup.
      void enqueueDelivery(result.order.id, log).catch((err) =>
        log.error({ err, order_id: result.order?.id }, 'delivery.enqueue_failed'),
      );
    }
    return result;
  });
}

/** Apply orphan payment events that arrived before the order existed. */
export async function applyPendingPaymentsForOrder(orderId: string, log: FastifyBaseLogger) {
  const pending = await pool.query(
    `SELECT payload FROM payment_events
     WHERE order_id = $1 AND applied = FALSE
     ORDER BY received_at ASC`,
    [orderId],
  );
  for (const row of pending.rows) {
    const payload = row.payload as PaymentWebhook;
    // Re-process by deleting applied=false marker path — use dedicated apply.
    await withTx(async (client) => {
      await applyStoredEvent(client, payload, log);
    });
  }
}

async function applyStoredEvent(client: TxClient, payload: PaymentWebhook, log: FastifyBaseLogger) {
  const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [
    payload.order_id,
  ]);
  if (orderRes.rowCount === 0) return;
  const order = mapOrder(orderRes.rows[0]);
  await client.query(`UPDATE payment_events SET applied = TRUE WHERE event_id = $1`, [
    payload.event_id,
  ]);
  if (payload.status === 'paid' && order.status === 'created') {
    const requestId = `${order.id}-issue`;
    await client.query(
      `UPDATE orders
       SET status = 'paid', paid_at = now(), request_id = $2,
           next_attempt_at = now(), updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'created'`,
      [order.id, requestId],
    );
    await client.query(
      `INSERT INTO ledger_entries (order_id, entry_type, amount, currency, description)
       VALUES ($1, 'payment_in', $2, $3, $4)`,
      [order.id, order.amount, order.currency, `Payment ${payload.event_id}`],
    );
    log.info({ order_id: order.id, event_id: payload.event_id }, 'payment.paid.deferred');
  } else if (payload.status === 'failed' && order.status === 'created') {
    await client.query(
      `UPDATE orders SET status = 'payment_failed', updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'created'`,
      [order.id],
    );
  }
}
