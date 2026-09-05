process.env.RUN_WORKER = 'false';
process.env.PROVIDER_A_FAIL_RATE = '1';
process.env.PROVIDER_A_TIMEOUT_RATE = '0';
process.env.PROVIDER_B_FAIL_RATE = '0';
process.env.PROVIDER_B_TIMEOUT_RATE = '0';
process.env.PROVIDER_MAX_RETRIES = '1';

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { stopWorker } = await import('../src/worker-loop.js');

async function main() {
  const app = await buildApp();
  await app.ready();

  const created = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { sku: 'GIFT-PSN-1000' },
  });
  const order = created.json() as { id: string; amount: number; currency: string };

  await app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: `evt_fb_${order.id}`,
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    },
  });

  let final: { status: string; provider: string | null; delivery_code: string | null } | null =
    null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const g = await app.inject({ method: 'GET', url: `/orders/${order.id}` });
    final = g.json();
    if (final && (final.status === 'delivered' || final.status === 'delivery_failed')) break;
  }

  stopWorker();
  await app.close();
  await pool.end();

  if (!final || final.status !== 'delivered' || !final.delivery_code) {
    throw new Error(`not delivered: ${JSON.stringify(final)}`);
  }
  if (final.provider !== 'B') {
    throw new Error(`expected provider B, got ${final.provider}`);
  }
  console.log('PASS: fallback A→B, one delivery', final);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
