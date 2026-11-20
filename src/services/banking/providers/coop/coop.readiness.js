// src/services/banking/providers/coop/coop.readiness.js

export function getCoopCapabilityProfile() {
  return {
    name: 'COOP',
    adapterPresent: true,
    implemented: true,
    operationalReady: false,
    capabilities: {
      authenticate: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['oauth_scope_and_token_lifecycle_unverified', 'sandbox_not_verified'],
        evidenceNote:
          'CK/SK client_credentials implemented; scopes/TTL not project-verified against sandbox',
      },
      accountValidation: {
        adapterPresent: true,
        contractVerified: true,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['sandbox_not_verified'],
        evidenceNote: 'MessageCode 0 / -1 semantics implemented; fail-closed on unknown codes',
      },
      polling: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: false,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['accounttransactions_item_schema_unverified'],
        evidenceNote: 'AccountTransactions item identity/uniqueness not verified',
      },
      statementImport: {
        adapterPresent: true,
        contractVerified: true,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['sandbox_not_verified'],
        evidenceNote:
          'FullStatement date-window path uses mapCoopFullStatementItem; TransactionDate vs ValueDate preserved',
      },
      balance: {
        adapterPresent: false,
        contractVerified: false,
        capabilityImplemented: false,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['endpoint_not_verified'],
        evidenceNote: 'Balance remains disabled pending verified resource documentation',
      },
      webhook: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['callback_retry_ack_unverified', 'auth_limited_to_basic_shared_secret'],
        evidenceNote: 'SendTransactionINS mapping exists; Basic shared secret only',
      },
    },
    evidenceNote: 'See docs/provider-contracts/CONTRACT_EVIDENCE.md',
  };
}
