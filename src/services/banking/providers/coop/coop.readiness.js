// src/services/banking/providers/coop/coop.readiness.js

export function getCoopCapabilityProfile() {
  return {
    name: 'COOP',
    adapterPresent: true,
    implemented: true,
    operationalReady: false, // overall: live auth/sandbox not verified in this environment
    capabilities: {
      authenticate: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['oauth_scope_and_token_lifecycle_unverified', 'sandbox_not_verified'],
        evidenceNote: 'Password grant implemented against portal-shaped /token; scopes/TTL not project-verified',
      },
      accountValidation: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['response_semantics_unverified', 'sandbox_not_verified'],
      },
      polling: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: false,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['accounttransactions_item_schema_unverified'],
        evidenceNote: 'AccountTransactions list item schema not expanded in verified docs',
      },
      statementImport: {
        adapterPresent: true,
        contractVerified: true,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['sandbox_not_verified'],
        evidenceNote: 'FullStatement date-window path implemented; TransactionDate vs ValueDate preserved',
      },
      balance: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['sandbox_not_verified'],
      },
      webhook: {
        adapterPresent: true,
        contractVerified: false,
        capabilityImplemented: true,
        credentialsConfigurable: true,
        sandboxVerified: false,
        operationalReady: false,
        blockers: ['callback_retry_ack_unverified', 'auth_limited_to_basic_shared_secret'],
        evidenceNote: 'SendTransactionINS mapping exists; verification is Basic shared secret only',
      },
    },
    evidenceNote: 'See docs/provider-contracts/CONTRACT_EVIDENCE.md',
  };
}
