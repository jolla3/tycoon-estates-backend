// src/services/banking/syncStrategy.js
//
// Bank-neutral synchronization strategy contract.
// Provider-specific pagination/cursor/date-window behaviour stays in adapters.

/**
 * @typedef {object} SyncPage
 * @property {object[]} items - adapter-normalized transaction candidates
 * @property {object|null} nextCursor - opaque provider continuation (strategy-defined)
 * @property {boolean} exhausted - no more pages in this run
 * @property {string} [cursorType] - 'date_window' | 'opaque_cursor' | 'page' | 'none'
 * @property {object} [checkpointCandidate] - value to persist only after durable accept
 * @property {Error|string} [pageError] - if set, page must not advance checkpoint
 */

/**
 * Strategy interface (not a hard class requirement for JS adapters).
 *
 * async begin(account, connection, checkpoint) → session state
 * async fetchPage(session) → SyncPage
 * async supportsOperationalSync() → boolean
 */
export class BankSyncStrategy {
  getProviderName() {
    throw new Error('getProviderName() not implemented');
  }

  /** Whether operational polling/sync is allowed under verified contracts. */
  supportsOperationalSync() {
    return false;
  }

  async begin(_account, _connection, _checkpoint, _adapter) {
    throw new Error('begin() not implemented');
  }

  async fetchPage(_session) {
    throw new Error('fetchPage() not implemented');
  }
}

export const SYNC_CURSOR_TYPES = Object.freeze([
  'none',
  'date_window',
  'opaque_cursor',
  'page',
]);
