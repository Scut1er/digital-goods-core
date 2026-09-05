/**
 * HTTP fallback check against a running API.
 * Start API with:
 *   PROVIDER_A_FAIL_RATE=1 PROVIDER_A_TIMEOUT_RATE=0
 *   PROVIDER_B_FAIL_RATE=0 PROVIDER_B_TIMEOUT_RATE=0
 *   PROVIDER_MAX_RETRIES=1
 * then: FALLBACK_MODE=1 npm run test:providers:http
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function main() {
  const created = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'GIFT-XBOX-1500' }),
  });
  const order = await json<{ id: string; amount: number; currency: string }>(created);

  await fetch(`${BASE}/webhook/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: `evt_fb_${order.id}`,
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    }),
  });

  let final: { status: string; provider: string | null; delivery_code: string | null } | null =
    null;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 500));
    final = await json(await fetch(`${BASE}/orders/${order.id}`));
    if (final && (final.status === 'delivered' || final.status === 'delivery_failed')) break;
  }

  console.log('final', final);
  if (!final || final.status !== 'delivered' || !final.delivery_code) {
    console.error('FAIL: not delivered');
    process.exit(1);
  }
  if (process.env.FALLBACK_MODE === '1' && final.provider !== 'B') {
    console.error('FAIL: expected provider B, got', final.provider);
    process.exit(1);
  }
  console.log('PASS: delivery succeeded', `(provider ${final.provider})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
