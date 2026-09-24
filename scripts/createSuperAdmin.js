// scripts/createSuperAdmin.js
//
// Minimal bootstrap script — NOT a sample-data seed. There is
// deliberately no public API path that creates a SUPER_ADMIN (signup
// only ever creates a CLIENT_OWNER of a brand-new client, and staff
// creation is restricted to STAFF/CLIENT_ADMIN) — this script is the one
// place a platform-level admin account gets created, run manually and
// only when you actually need one.
//
// Usage:
//   node scripts/createSuperAdmin.js "Name" email@example.com "password"
//
// Does NOT create any client, estate, house, tenant, or bank data — no
// stale sample dataset. Real test data is the operator's own concern.

import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { User } from '../src/models/User.js';
import { logger } from '../src/config/logger.js';

const [, , name, email, password] = process.argv;

if (!name || !email || !password) {
  console.error('Usage: node scripts/createSuperAdmin.js "Name" email@example.com "password"');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

async function run() {
  await connectDatabase();

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    logger.error({ email }, 'A user with this email already exists — refusing to create a duplicate SUPER_ADMIN');
    await disconnectDatabase();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await User.create({ name, email: email.toLowerCase(), passwordHash, role: 'SUPER_ADMIN' });

  logger.info({ userId: String(admin._id), email }, 'SUPER_ADMIN created');
  await disconnectDatabase();
}

run().catch((err) => {
  logger.error({ error: err.message }, 'Failed to create SUPER_ADMIN');
  process.exit(1);
});
