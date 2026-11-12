// src/services/banking/providers/coop/coop.syncStrategy.js
//
// Co-op sync strategy.
// AccountTransactions item schema is UNVERIFIED → operational incremental
// polling via that endpoint is disabled.
// AccountFullStatement supports date-window retrieval (documented StartDate/EndDate).
// Overlaps are safe via Batch 03 idempotency.

import { BankSyncStrategy } from '../../syncStrategy.js';
import { mapCoopFullStatementItem, mapCoopPolledTransaction } from './coop.mapper.js';
import { Errors } from '../../../../utils/errors.js';
import { logger } from '../../../../config/logger.js';

const MS_DAY = 24 * 60 * 60 * 1000;

function ymd(d) {
  const x = new Date(d);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Operational policy for Co-op:
 * - statement date-window sync: allowed when adapter can call getFullStatement
 * - AccountTransactions list polling: not operational (unverified item schema)
 */
export class CoopSyncStrategy extends BankSyncStrategy {
  constructor({ mode = 'full_statement_window', windowDays = 7 } = {}) {
    super();
    this.mode = mode;
    this.windowDays = windowDays;
  }

  getProviderName() {
    return 'COOP';
  }

  supportsOperationalSync() {
    // FullStatement date window is the only operational path until
    // AccountTransactions item schema is verified.
    return this.mode === 'full_statement_window';
  }

  /**
   * @returns {Promise<object>} session
   */
  async begin(account, connection, checkpoint, adapter) {
    if (!this.supportsOperationalSync()) {
      throw Errors.Conflict(
        'Co-op AccountTransactions polling is not operational until the item schema is verified'
      );
    }
    if (typeof adapter.getFullStatement !== 'function') {
      throw Errors.Conflict('Co-op adapter does not support full statement retrieval');
    }

    const acceptedThrough = checkpoint?.acceptedThrough
      ? new Date(checkpoint.acceptedThrough)
      : null;

    // Overlap one day when resuming so equal timestamps are not skipped.
    let start = acceptedThrough
      ? new Date(acceptedThrough.getTime() - MS_DAY)
      : new Date(Date.now() - this.windowDays * MS_DAY);
    const end = new Date();

    if (start > end) start = new Date(end.getTime() - MS_DAY);

    return {
      account,
      connection,
      adapter,
      start,
      end,
      done: false,
      cursorType: 'date_window',
    };
  }

  async fetchPage(session) {
    if (session.done) {
      return {
        items: [],
        nextCursor: null,
        exhausted: true,
        cursorType: 'date_window',
        checkpointCandidate: null,
      };
    }

    const startDate = ymd(session.start);
    const endDate = ymd(session.end);

    let rawItems;
    try {
      // Provider returns already-mapped list from getFullStatement in current adapter
      // (mapCoopPolledTransaction). Prefer FullStatement field mapping when raw shape allows.
      const mapped = await session.adapter.getFullStatement(
        session.account,
        startDate,
        endDate
      );
      rawItems = Array.isArray(mapped) ? mapped : [];
    } catch (err) {
      logger.warn({ error: err.message }, 'Co-op full statement fetch failed');
      return {
        items: [],
        nextCursor: null,
        exhausted: true,
        cursorType: 'date_window',
        checkpointCandidate: null,
        pageError: err.message || 'statement_fetch_failed',
      };
    }

    // Re-map through FullStatement helper when payload looks documented;
    // otherwise keep adapter mapping but mark unverified.
    const items = rawItems.map((item) => {
      if (item?.rawPayload && (item.rawPayload.CreditAmount != null || item.rawPayload.DebitAmount != null)) {
        return mapCoopFullStatementItem(item.rawPayload);
      }
      return {
        ...item,
        sourceChannel: 'poll',
        schemaUnverified: item.schemaUnverified !== false,
      };
    });

    session.done = true; // single window per run; continuation is next schedule with new acceptedThrough

    const checkpointCandidate = {
      type: 'date_window',
      value: { startDate, endDate },
      acceptedThrough: session.end,
    };

    return {
      items,
      nextCursor: null,
      exhausted: true,
      cursorType: 'date_window',
      checkpointCandidate,
    };
  }
}

export function createCoopSyncStrategy() {
  return new CoopSyncStrategy({ mode: 'full_statement_window' });
}

/** Explicit non-operational AccountTransactions strategy (documented limitation). */
export class CoopUnverifiedTransactionsPollStrategy extends BankSyncStrategy {
  getProviderName() {
    return 'COOP';
  }

  supportsOperationalSync() {
    return false;
  }

  async begin() {
    throw Errors.Conflict(
      'Co-op AccountTransactions item schema is unverified; operational polling is disabled'
    );
  }

  async fetchPage() {
    throw Errors.Conflict(
      'Co-op AccountTransactions item schema is unverified; operational polling is disabled'
    );
  }
}
