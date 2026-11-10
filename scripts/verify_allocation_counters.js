/**
 * Legacy command filename retained for compatibility.
 * Read-only: verify PaymentAllocation structural integrity.
 * The deprecated Payment.allocatedCents mirror is not compared.
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
