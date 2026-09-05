import Fastify from 'fastify';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { startWorker } from './worker-loop.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  await registerRoutes(app);

  if (config.runWorker) {
    startWorker(app.log);
  }

  return app;
}
