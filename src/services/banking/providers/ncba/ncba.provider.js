// src/services/banking/providers/ncba/ncba.provider.js
//
// NCBA adapter shell. No public developer API products listed for NCBA
// Group on open-banking trackers as of evidence date. Fail closed.

import { DisabledBankProvider } from '../disabledProvider.js';

export const NCBA_CONTRACT_NOTE =
  'NCBA Group has no project-verified public developer API contract (see docs/provider-contracts/CONTRACT_EVIDENCE.md)';

export class NcbaBankProvider extends DisabledBankProvider {
  constructor(_credentialContext = {}) {
    super('NCBA', NCBA_CONTRACT_NOTE);
    this._credentialContextPresent = Boolean(
      _credentialContext && Object.keys(_credentialContext).length
    );
  }
}

export function getNcbaCapabilityProfile() {
  return {
    name: 'NCBA',
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
    evidenceNote: NCBA_CONTRACT_NOTE,
  };
}
