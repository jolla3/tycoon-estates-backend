// tests/setup.js — env defaults so importing config/environment.js doesn't warn/crash during tests.
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
