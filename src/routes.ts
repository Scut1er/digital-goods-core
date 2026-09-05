import type { FastifyInstance } from 'fastify';
import { createOrder, createOrderWithId, getOrder, handlePaymentWebhook, applyPendingPaymentsForOrder } from './services/orders.js';
import { deliverOrder, recoverStuckOrders } from './services/delivery.js';
import { reconcile } from './services/reconcile.js';
import { explainStorefrontStock, getStorefrontStock } from './services/catalog.js';
import { providerIssueHandler, type ProviderName } from './services/providers.js';
import type { PaymentWebhook } from './types.js';

export async function registerRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));

  app.post<{ Body: { sku: string; id?: string } }>('/orders', async (req, reply) => {
    const sku = req.body?.sku;
    if (!sku || typeof sku !== 'string') {
      return reply.code(400).send({ error: 'sku_required' });
    }
    try {
      const order = req.body.id
        ? await createOrderWithId(req.body.id, sku)
        : await createOrder(sku);
      // Apply any webhooks that arrived early for this id (rare; mainly for predetermined ids in tests)
      await applyPendingPaymentsForOrder(order.id, req.log);
      const fresh = (await getOrder(order.id)) ?? order;
      if (fresh.status === 'paid') {
        void deliverOrder(fresh.id, req.log);
      }
      return reply.code(201).send(serializeOrder(fresh));
    } catch (err) {
      if (err instanceof Error && err.message === 'SKU_NOT_FOUND') {
        return reply.code(404).send({ error: 'sku_not_found' });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    const order = await getOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: 'not_found' });
    return serializeOrder(order);
  });

  app.post<{ Body: PaymentWebhook }>('/webhook/payment', async (req, reply) => {
    const body = req.body;
    if (!body?.event_id || !body?.order_id || !body?.status) {
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    if (body.status !== 'paid' && body.status !== 'failed') {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    try {
      const result = await handlePaymentWebhook(body, req.log);
      return reply.code(200).send({
        ok: true,
        duplicate: result.duplicate,
        order: result.order ? serializeOrder(result.order) : null,
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      req.log.error({ err }, 'payment.webhook.error');
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.get('/catalog/stock', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const items = await getStorefrontStock(limit, offset);
    return { items, limit, offset };
  });

  app.get('/catalog/stock/explain', async () => {
    const plan = await explainStorefrontStock();
    return {
      plan,
      notes: [
        'product_stock is a denormalized counter (trigger-maintained) — no COUNT on inventory_keys',
        'Expect Index Scan on product_stock_available_idx + Nested Loop to products PK',
        'Partial index WHERE available_qty > 0 keeps the hot set small',
      ],
    };
  });

  app.get('/admin/reconcile', async () => reconcile());

  app.post('/admin/recover', async (req) => {
    const n = await recoverStuckOrders(req.log);
    return { recovered: n };
  });

  // In-process provider stubs (same contract as external /issue)
  app.post<{ Params: { name: string }; Body: { request_id: string; sku: string; order_id: string } }>(
    '/providers/:name/issue',
    async (req, reply) => {
      const name = req.params.name.toUpperCase();
      if (name !== 'A' && name !== 'B') {
        return reply.code(404).send({ error: 'unknown_provider' });
      }
      const { request_id, sku, order_id } = req.body ?? {};
      if (!request_id || !sku || !order_id) {
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      const result = await providerIssueHandler(name as ProviderName, { request_id, sku, order_id });
      return reply.code(result.statusCode).send(result.body);
    },
  );
}

function serializeOrder(order: {
  id: string;
  sku: string;
  amount: number;
  currency: string;
  status: string;
  delivery_code: string | null;
  provider: string | null;
  request_id: string | null;
  last_error: string | null;
  paid_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: order.id,
    sku: order.sku,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    delivery_code: order.delivery_code,
    provider: order.provider,
    request_id: order.request_id,
    last_error: order.last_error,
    paid_at: order.paid_at,
    delivered_at: order.delivered_at,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}
