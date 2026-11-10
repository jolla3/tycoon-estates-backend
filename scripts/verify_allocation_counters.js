/**
 * Read-only: verify Payment.allocatedCents vs PaymentAllocation sums.
 * Does not modify data. Exit 1 if mismatches.
 */
import mongoose from 'mongoose';
import { verifyAllocationCounters } from '../src/utils/allocationCounterReadiness.js';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('MONGODB_URI required');
  process.exit(2);
}
await mongoose.connect(uri);
const report = await verifyAllocationCounters({ setReady: false });
console.log(JSON.stringify(report, null, 2));
await mongoose.disconnect();
process.exit(report.ok ? 0 : 1);
