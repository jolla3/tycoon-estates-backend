// src/config/logger.js
//
// Development: human-readable pino-pretty lines.
// Production: structured JSON (for log aggregators).
//
// Never log passwords, tokens, API keys, or full bank account numbers.

import pino from 'pino';

// Read NODE_ENV directly so this module does not depend on environment.js
// (avoids import cycles and ensures pretty mode works even if env loads late).
const isProd = process.env.NODE_ENV === 'production';

const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  '*.password',
  '*.passwordHash',
  '*.apikey',
  '*.apiKey',
  '*.clientSecret',
  '*.accountNumber',
  '*.accountNumberEncrypted',
  '*.encryptionKey',
  '*.COOKIE_SECRET',
  '*.SESSION_SECRET',
  '*.ENCRYPTION_KEY',
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        },
      }),
});
