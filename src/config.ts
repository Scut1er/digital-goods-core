import 'dotenv/config';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://shop:shop@localhost:5432/shop',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  runWorker: (process.env.RUN_WORKER ?? 'true') === 'true',
  providerTimeoutMs: num('PROVIDER_TIMEOUT_MS', 1500),
  providerMaxRetries: num('PROVIDER_MAX_RETRIES', 3),
  workerPollMs: num('WORKER_POLL_MS', 2000),
  providerA: {
    failRate: num('PROVIDER_A_FAIL_RATE', 0.3),
    timeoutRate: num('PROVIDER_A_TIMEOUT_RATE', 0.2),
  },
  providerB: {
    failRate: num('PROVIDER_B_FAIL_RATE', 0.2),
    timeoutRate: num('PROVIDER_B_TIMEOUT_RATE', 0.1),
  },
};
