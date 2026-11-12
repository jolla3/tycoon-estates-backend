// src/services/banking/providers/equity/equity.provider.js
//
// Equity Jenga adapter shell. Official developer site is publicly named
// (developer.jengahq.io) but this project has no verified, owned API
// contract for operational G4 use. Fail closed.

import { DisabledBankProvider } from '../disabledProvider.js';

export const EQUITY_CONTRACT_NOTE =
  'Equity Jenga is publicly documented at a high level; project lacks verified owned OpenAPI/sandbox evidence for G4 (see docs/provider-contracts/CONTRACT_EVIDENCE.md)';

export class EquityBankProvider extends DisabledBankProvider {
  constructor(_credentialContext = {}) {
    super('EQUITY', EQUITY_CONTRACT_NOTE);
    this._credentialContextPresent = Boolean(
      _credentialContext && Object.keys(_credentialContext).length
    );
  }
}

export function getEquityCapabilityProfile() {
  return {
    name: 'EQUITY',
    adapterPresent: true,
    implemented: false,
    operationalReady: false,
    capabilities: {
      authenticate: { operationalReady: false, blockers: ['contract_unverified'] },
      accountValidation: { operationalReady: false, blockers: ['contract_unverified'] },
      polling: { operationalReady: false, blockers: ['contract_unverified'] },
      statementImport: { operationalReady: false, blockers: ['contract_unverified'] },
      balance: { operationalReady: false, blockers: ['contract_unverified'] },
      webhook: { operationalReady: false, blockers: ['contract_unverified'] },
    },
    evidenceNote: EQUITY_CONTRACT_NOTE,
  };
}
