// src/services/banking/providers/kcb/kcb.provider.js
//
// KCB Buni adapter shell. Public portal exists (sandbox.buni.kcbgroup.com)
// but this workspace has no verified OpenAPI for account-transaction
// monitoring suitable for G4 rent attribution. All capabilities fail closed.

import { DisabledBankProvider } from '../disabledProvider.js';

export const KCB_CONTRACT_NOTE =
  'KCB Buni portal exists; project lacks verified account-statement/AIS contract and sandbox evidence for G4 (see docs/provider-contracts/CONTRACT_EVIDENCE.md)';

export class KcbBankProvider extends DisabledBankProvider {
  constructor(_credentialContext = {}) {
    super('KCB', KCB_CONTRACT_NOTE);
    // Credential context accepted for future connection-scoped wiring —
    // never used to call fabricated endpoints.
    this._credentialContextPresent = Boolean(
      _credentialContext && Object.keys(_credentialContext).length
    );
  }
}

export function getKcbCapabilityProfile() {
  return {
    name: 'KCB',
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
    evidenceNote: KCB_CONTRACT_NOTE,
  };
}
