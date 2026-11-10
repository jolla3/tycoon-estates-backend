import { DepositMovement } from '../models/DepositMovement.js';

export async function inspectDepositMovementIndex() {
  try {
    const indexes = await DepositMovement.collection.listIndexes().toArray();
    const index = indexes.find((candidate) => {
      const keys = Object.entries(candidate.key || {});
      return keys.length === 2
        && keys[0][0] === 'clientId' && keys[0][1] === 1
        && keys[1][0] === 'idempotencyKey' && keys[1][1] === 1;
    });

    if (!index) {
      return { aligned: false, reason: 'DepositMovement idempotency index is missing' };
    }

    const partial = index.partialFilterExpression?.idempotencyKey;
    const partialAligned = partial?.$type === 'string'
      && Object.keys(partial).length === 1;

    if (index.unique !== true || !partialAligned) {
      return {
        aligned: false,
        indexName: index.name,
        reason: 'DepositMovement index must be unique and partial on string idempotencyKey',
      };
    }

    return { aligned: true, indexName: index.name };
  } catch (err) {
    return { aligned: false, reason: err.message };
  }
}
