process.env.RUN_WORKER = 'false';
process.env.PROVIDER_A_FAIL_RATE = '0';
process.env.PROVIDER_A_TIMEOUT_RATE = '0';
process.env.PROVIDER_B_FAIL_RATE = '0';
process.env.PROVIDER_B_TIMEOUT_RATE = '0';

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { stopWorker } = await import('../src/worker-loop.js');

async function main() {
  const app = await buildApp();
  await app.ready();

  const create = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { sku: 'SUB-SPOTIFY-1M' },
  });
  if (create.statusCode !== 201) throw new Error(`create ${create.statusCode} ${create.body}`);
  const order = create.json() as { id: string; amount: number; currency: string };

  const paid = await app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: `evt_unit_${order.id}`,
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    },
  });
  if (paid.statusCode !== 200) throw new Error(`paid ${paid.statusCode} ${paid.body}`);

  let status = '';
  let code: string | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const g = await app.inject({ method: 'GET', url: `/orders/${order.id}` });
    const body = g.json() as { status: string; delivery_code: string | null };
    status = body.status;
    code = body.delivery_code;
    if (status === 'delivered') break;
  }
  if (status !== 'delivered' || !code) throw new Error(`expected delivered, got ${status}`);

  const dup = await app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: `evt_unit_${order.id}`,
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    },
  });
  if (!(dup.json() as { duplicate: boolean }).duplicate) throw new Error('expected duplicate');

  const earlyId = `ord_early_${Date.now()}`;
  const earlyEvt = `evt_early_${Date.now()}`;
  const earlyWh = await app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: earlyEvt,
      order_id: earlyId,
      status: 'paid',
      amount: 299,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    },
  });
  if (earlyWh.statusCode !== 200) throw new Error('early webhook should 200');

  const lateCreate = await app.inject({
    method: 'POST',
    url: '/orders',
    payload: { sku: 'SUB-SPOTIFY-1M', id: earlyId },
  });
  if (lateCreate.statusCode !== 201) throw new Error(`late create ${lateCreate.statusCode} ${lateCreate.body}`);

  let earlyStatus = '';
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const g = await app.inject({ method: 'GET', url: `/orders/${earlyId}` });
    earlyStatus = (g.json() as { status: string }).status;
    if (earlyStatus === 'delivered' || earlyStatus === 'paid') break;
  }
  if (earlyStatus === 'created') throw new Error('early webhook was not applied after order create');

  stopWorker();
  await app.close();
  await pool.end();
  console.log('PASS: smoke (create/pay/deliver/duplicate/early-webhook)');
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
