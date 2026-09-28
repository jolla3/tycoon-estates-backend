// src/app.js
//
// Express app assembly. No provider or MongoDB business logic lives here —
// just middleware wiring and route mounting (section 21).

import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';

import { env, isProduction, isCrossSiteFrontend } from './config/environment.js';
import { helmetMiddleware, corsMiddleware } from './config/security.js';
import { isDatabaseReady, supportsMongoTransactions } from './config/database.js';
import { checkRedisHealth } from './config/redis.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { issueCsrfCookie, csrfProtection } from './middlewares/csrf.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { generalApiRateLimiter } from './middlewares/rateLimiter.js';
import { User } from './models/User.js';
import apiRoutes from './routes/index.js';
import webhookRoutes from './routes/webhook.routes.js';
import { openApiSpec } from './docs/openapi.js';

export function createApp() {
  const app = express();

  // Section 25 (V2): correctly captures the originating IP for audit
  // logs when running behind a reverse proxy / load balancer, without
  // blindly trusting arbitrary X-Forwarded-For values from the public
  // internet. `1` == trust exactly one hop (the proxy in front of this
  // process) — adjust if your deployment adds more hops.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.disable('x-powered-by');
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));

  // Unsigned cookie parser. CSRF is a double-submit cookie read from
  // req.cookies (not signed). Do NOT pass a secret here: that sets
  // req.secret and triggers express-session's deprecated fallback path.
  app.use(cookieParser());
  app.use(requestLogger);

  // express-session requires a non-empty secret option. Never rely on
  // cookie-parser's req.secret (deprecated and removed as a dependency).
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || typeof sessionSecret !== 'string' || !sessionSecret.trim()) {
    throw new Error(
      '[config] SESSION_SECRET is missing or empty. Set it in .env ' +
        '(e.g. node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))").'
    );
  }

  // Shared session store (MongoDB-backed) so any API instance behind the
  // load balancer can serve any request — section 26.
  // Cross-site SPA (Vercel) talking to API (Render) needs SameSite=None + Secure
  // so the browser stores and re-sends the session cookie on credentialed fetches.
  const crossSite = isCrossSiteFrontend();
  app.use(
    session({
      name: 'connect.sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      proxy: true, // trust X-Forwarded-* from Render so secure cookies work
      store: MongoStore.create({ mongoUrl: env.MONGODB_URI }),
      cookie: {
        httpOnly: true,
        secure: crossSite || isProduction,
        sameSite: crossSite || isProduction ? 'none' : 'lax',
        path: '/',
        maxAge: 8 * 60 * 60 * 1000,
      },
    })
  );

  // Loads req.currentUser ahead of the per-route `authenticate` middleware
  // so CSRF/rate-limit decisions and audit logs can use it when present.
  app.use(async (req, _res, next) => {
    try {
      if (req.session?.userId) req.currentUser = await User.findById(req.session.userId);
    } catch (_err) {
      // Non-fatal — `authenticate` will reject the request downstream if needed.
    }
    next();
  });

  // Liveness probes BEFORE session/CSRF side-effects so responses never Set-Cookie.
  // SPA uses GET /api/v1/health; load balancers may use GET /health.
  const healthHandler = (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  };
  app.get('/health', healthHandler);
  app.get('/api/v1/health', healthHandler);

  app.use(issueCsrfCookie);

  // Auth/session JSON must never be cached by the browser or a CDN.
  // A 304 on /auth/me can leave the SPA thinking the session is still invalid.
  app.use('/api/v1', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    next();
  });
  app.use('/api/v1', generalApiRateLimiter);
  app.use('/api/v1/webhooks', webhookRoutes); // no CSRF — bank auth handles this
  app.use('/api/v1', csrfProtection, apiRoutes);

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  // Section 27: readiness (liveness /health is registered earlier, before /api/v1).
  app.get('/ready', async (_req, res) => {
    const mongo = isDatabaseReady();
    const redisResult = await checkRedisHealth(400);
    const redis = redisResult.status === 'healthy';
    const txSupport = supportsMongoTransactions();
    const ready = mongo && redis;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      mongo: mongo ? 'ready' : 'not_ready',
      redis: redis ? 'ready' : 'not_ready',
      redisLatencyMs: redisResult.latencyMs ?? null,
      // true | false | null (unknown) — standalone Mongo cannot run financial transactions
      mongoTransactionsSupported: txSupport,
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}