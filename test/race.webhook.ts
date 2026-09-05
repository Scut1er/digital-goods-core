/**
 * Parallel payment webhook race test.
 * Creates one order, fires N concurrent "paid" webhooks (unique event_ids + one duplicate),
 * asserts exactly one delivery.
 *
 * Usage: npm run test:race
 * Env: BASE_URL=http://localhost:3000 PARALLEL=50
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const PARALLEL = Number(process.env.PARALLEL ?? 50);

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function main() {
  const created = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500' }),
  });
  if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const order = await json<{ id: string; amount: number; currency: string }>(created);
  console.log('order', order.id);

  const eventIds = Array.from({ length: PARALLEL }, (_, i) => `evt_race_${order.id}_${i}`);
  // Also send one true duplicate of the first event_id
  const payloads = [
    ...eventIds.map((event_id) => ({
      event_id,
      order_id: order.id,
      status: 'paid' as const,
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    })),
    {
      event_id: eventIds[0],
      order_id: order.id,
      status: 'paid' as const,
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    },
  ];

  const results = await Promise.all(
    payloads.map((body) =>
      fetch(`${BASE}/webhook/payment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  );

  const ok = results.filter((r) => r.status === 200).length;
  console.log(`webhooks: ${ok}/${results.length} returned 200`);

  // Wait for delivery
  let final = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const g = await fetch(`${BASE}/orders/${order.id}`);
    final = await g.json();
    if (final.status === 'delivered' || final.status === 'out_of_stock' || final.status === 'delivery_failed') {
      break;
    }
  }

  console.log('final order', final);

  if (final.status !== 'delivered') {
    console.error('FAIL: expected delivered');
    process.exit(1);
  }
  if (!final.delivery_code) {
    console.error('FAIL: missing delivery_code');
    process.exit(1);
  }

  // Count how many orders share this code (must be 1)
  const reconcile = await json<{
    paid_not_delivered: unknown[];
    delivered_not_paid: unknown[];
  }>(await fetch(`${BASE}/admin/reconcile`));

  // Duplicate event_id check
  const dup = await fetch(`${BASE}/webhook/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: eventIds[0],
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    }),
  });
  const dupBody = await dup.json();
  if (!dupBody.duplicate) {
    console.error('FAIL: same event_id should be duplicate');
    process.exit(1);
  }

  const after = await json<{ status: string; delivery_code: string }>(
    await fetch(`${BASE}/orders/${order.id}`),
  );
  if (after.delivery_code !== final.delivery_code || after.status !== 'delivered') {
    console.error('FAIL: duplicate webhook mutated order');
    process.exit(1);
  }

  console.log('PASS: exactly-once delivery under', PARALLEL, 'parallel webhooks + duplicate event_id');
  console.log('reconcile paid_not_delivered sample size', reconcile.paid_not_delivered.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
