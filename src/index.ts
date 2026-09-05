import { buildApp } from './app.js';
import { config } from './config.js';

async function main() {
  const app = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`API listening on :${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
