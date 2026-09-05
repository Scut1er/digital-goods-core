import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import { recoverStuckOrders } from './services/delivery.js';
import { applyOrphanPaymentEvents } from './services/orphan-payments.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWorker(log: FastifyBaseLogger) {
  if (timer) return;
  log.info({ pollMs: config.workerPollMs }, 'worker.started');
  timer = setInterval(() => {
    void tick(log);
  }, config.workerPollMs);
}

async function tick(log: FastifyBaseLogger) {
  if (running) return;
  running = true;
  try {
    await applyOrphanPaymentEvents(log);
    const n = await recoverStuckOrders(log, 20);
    if (n > 0) log.info({ n }, 'worker.recovered');
  } catch (err) {
    log.error({ err }, 'worker.error');
  } finally {
    running = false;
  }
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
