// tests/helpers/db.js
//
// Integration tests need a real MongoDB instance. Set MONGODB_URI (e.g. to
// a local `mongod` or a disposable Atlas/Docker instance) before running
// `npm test` for these to execute; otherwise they're skipped so `npm test`
// still passes using just the DB-free unit tests in tests/unit/.
import mongoose from 'mongoose';

export const hasMongo = !!process.env.MONGODB_URI;
export const describeWithMongo = hasMongo ? describe : describe.skip;

export async function connectTestDb() {
  await mongoose.connect(process.env.MONGODB_URI);
}
export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
export async function disconnectTestDb() {
  await mongoose.connection.close();
}
