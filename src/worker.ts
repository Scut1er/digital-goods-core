import { startWorker } from './worker-loop.js';
import Fastify from 'fastify';

const log = Fastify().log;
startWorker(log);

// Keep process alive
setInterval(() => undefined, 1 << 30);
