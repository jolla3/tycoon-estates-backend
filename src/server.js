// src/server.js — process bootstrap. Behind a load balancer, this process
// keeps no per-request state locally (sessions live in MongoDB via
// connect-mongo), so multiple instances can run identical copies of this
// file (section 26).

import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { ensureRedisReady, disconnectRedis } from './config/redis.js';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs/scheduler.js';
import { logger } from './config/logger.js';
import { env } from './config/environment.js';

async function start() {
  await connectDatabase();
  // Bounded wait for a real PING. Production fails hard if Redis never answers.
  await ensureRedisReady({ timeoutMs: 8000 });

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Tycoon Estates backend listening on :${env.PORT}`);
  });

  startBackgroundJobs();

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopBackgroundJobs();
    server.close(async () => {
      await disconnectDatabase();
      await disconnectRedis();
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.error({ error: err.message }, 'Fatal startup error');
  process.exit(1);
});
