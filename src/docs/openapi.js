// src/docs/openapi.js
//
// Section 32: minimal but real OpenAPI 3.0 document covering auth, the
// core CRUD resources, and the Co-op webhook. Kept hand-written and small
// per section 41 ("do not over-engineer") — extend paths as the API grows
// rather than reaching for a code-generation pipeline.
// G5: collection routes, public submission, Daraja webhooks added.

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Tycoon Estates Payment Monitoring API',
    version: '1.0.0',
    description: 'Multi-tenant rent-payment monitoring backend. Cookie-based session auth; state-changing requests require the X-CSRF-Token header (see the csrf-token cookie).',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    schemas: {
      ApiSuccess: {
        type: 'object',
        properties: { success: { type: 'boolean', example: true }, data: { type: 'object' }, message: { type: 'string' } },
      },
      ApiError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
        },
      },
      TenantRegistrationRequest: {
        type: 'object',
        required: ['name', 'houseId'],
        properties: {
          name: { type: 'string', minLength: 1 },
          phone: { type: 'string', nullable: true, description: 'Optional. Omit, send null or an empty string when the tenant has no phone.' },
          houseId: { type: 'string', minLength: 1 },
          moveInDate: { type: 'string', format: 'date', description: 'Optional move-in date.' },
        },
      },
      MpesaTenantLink: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          estateId: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'REVOKED'] },
          version: { type: 'integer', minimum: 1 },
          rotatedAt: { type: 'string', format: 'date-time', nullable: true },
          revokedAt: { type: 'string', format: 'date-time', nullable: true },
          operational: { type: 'boolean' },
        },
        description: 'Safe link metadata only. Never contains the raw bearer token, token digest or encrypted token envelope.',
      },
      MpesaLinkIssueResponse: {
        type: 'object',
        properties: {
          link: { $ref: '#/components/schemas/MpesaTenantLink' },
          created: { type: 'boolean' },
          smsMeta: {
            type: 'object',
            properties: {
              queued: { type: 'boolean' },
              created: { type: 'boolean' },
              reason: { type: 'string', nullable: true },
              messageId: { type: 'string', nullable: true },
            },
          },
        },
      },
      MpesaLinkResendResponse: {
        type: 'object',
        properties: {
          link: { $ref: '#/components/schemas/MpesaTenantLink' },
          queued: { type: 'boolean' },
          reason: { type: 'string', nullable: true },
        },
      },
      MpesaLinkRotateRequest: {
        type: 'object',
        required: ['expectedLinkVersion'],
        additionalProperties: false,
        properties: {
          expectedLinkVersion: { type: 'integer', minimum: 1, description: 'Current inspected link version; prevents rotating a stale link.' },
        },
      },
      MpesaLinkRotateResponse: {
        type: 'object',
        properties: {
          link: { $ref: '#/components/schemas/MpesaTenantLink' },
          smsMeta: {
            type: 'object',
            properties: {
              queued: { type: 'boolean' },
              created: { type: 'boolean' },
              reason: { type: 'string', nullable: true },
              messageId: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'connect.sid' },
      csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required for state-changing authenticated API requests.' },
    },
  },
  security: [{ cookieAuth: [] }],
  paths: {
    '/users/{id}/activate': {
      post: {
        tags: ['Users'],
        summary: 'Reactivate a staff user within the authenticated client',
        responses: { 200: { description: 'Staff activated' }, 403: { description: 'Forbidden' } },
      },
    },

    '/sms/broadcast': {
      post: {
        tags: ['SMS'],
        summary: 'Broadcast SMS to a recipient group',
        description: 'Creates one queued SMS job per recipient. Does not wait for provider delivery.',
        responses: { 202: { description: 'Broadcast queued' }, 403: { description: 'Forbidden' } },
      },
    },
    '/sms/preview': {
      post: {
        tags: ['SMS'],
        summary: 'Preview an SMS template without sending',
        description: 'Billing notification previews require tenantId or houseId and are calculated from saved RentCharge rows. Caller-supplied amounts are not accepted as the billing source of truth. Estate identity is resolved by the backend.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  template: { type: 'string', enum: ['billing_notification', 'rent_reminder', 'arrears_notice', 'payment_confirmation'] },
                  tenantId: { type: 'string' },
                  houseId: { type: 'string' },
                  period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
                },
                description: 'For billing_notification (or omitted template), tenantId or houseId is required.',
              },
            },
          },
        },
        responses: { 200: { description: 'Preview message and source-derived variables' }, 400: { description: 'Billing source identifiers or stored financial data invalid' } },
      },
    },

    '/auth/signup': { post: { summary: 'Create a new Client + its first CLIENT_OWNER user', security: [], responses: { 201: { description: 'Created' } } } },
    '/auth/login': { post: { summary: 'Log in (sets session cookie)', security: [], responses: { 200: { description: 'OK' } } } },
    '/auth/logout': { post: { summary: 'Log out', responses: { 200: { description: 'OK' } } } },
    '/auth/me': { get: { summary: 'Current user', responses: { 200: { description: 'OK' } } } },
    '/profile': {
      get: { summary: "Authenticated user's own profile", responses: { 200: { description: 'OK' } } },
      patch: { summary: "Update the authenticated user's own profile", responses: { 200: { description: 'OK' } } },
    },
    '/profile/change-password': { post: { summary: "Change the authenticated user's own password", responses: { 200: { description: 'OK' } } } },
    '/users': {
      get: { summary: 'List staff within the caller\'s client', responses: { 200: { description: 'OK' } } },
      post: { summary: 'Create a STAFF/CLIENT_ADMIN user within the caller\'s client', responses: { 201: { description: 'Created' } } },
    },
    '/houses': {
      get: { summary: 'List houses for the current client (optionally filtered by estateId)', responses: { 200: { description: 'OK' } } },
      post: { summary: 'Create a house under one of the caller\'s estates', responses: { 201: { description: 'Created' } } },
    },
    '/tenants': {
      get: { summary: 'List tenants', responses: { 200: { description: 'OK' } } },
      post: {
        summary: 'Register a tenant and queue the estate-aware welcome notification',
        description: 'Phone is optional. Tenant and Tenancy creation plus the appropriate standard or protected SMS outbox write use the existing registration transaction; Celcom is called later by the dispatcher.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/TenantRegistrationRequest' } } },
        },
        responses: {
          201: { description: 'Tenant created; notification queued when a valid phone and eligible delivery path exist.' },
          400: { description: 'Invalid registration data' },
          409: { description: 'House/tenancy conflict' },
          503: { description: 'Required eligible M-PESA protected outbox write failed; registration transaction rolled back.' },
        },
      },
    },
    '/tenants/{id}/move': {
      post: {
        summary: 'Move a tenant to another house',
        description: 'A same-estate move preserves the estate-scoped M-PESA link. A cross-estate move retires the old estate link on final exit and provisions the destination estate flow.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['houseId'], properties: { houseId: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Tenant moved' }, 404: { description: 'Tenant/house not found' }, 409: { description: 'Target house already occupied' } },
      },
    },
    '/payments': { get: { summary: 'List confirmed payments', responses: { 200: { description: 'OK' } } } },
    '/bank/accounts': {
      get: { summary: 'List connected bank accounts', responses: { 200: { description: 'OK' } } },
      post: { summary: 'Connect a bank account for one of the caller\'s estates', responses: { 201: { description: 'Created' } } },
    },
    '/bank/accounts/{id}/sync': {
      post: { summary: 'Sync recent transactions from the provider (Co-op AccountTransactions)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } },
    },
    '/bank/accounts/{id}/statement': {
      get: { summary: 'Import a historical statement for a date range (Co-op AccountFullStatement)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } },
    },
    '/transactions': { get: { summary: 'List normalized bank transactions', responses: { 200: { description: 'OK' } } } },
    '/transactions/unmatched': { get: { summary: 'List UNMATCHED transactions awaiting manual assignment', responses: { 200: { description: 'OK' } } } },
    '/transactions/{id}/assign': {
      post: { summary: 'Manually assign an UNMATCHED transaction to a house', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } },
    },
    '/sms/send': { post: { summary: 'Queue an outbound SMS', responses: { 202: { description: 'Accepted' } } } },
    '/sms/history': { get: { summary: 'SMS send history', responses: { 200: { description: 'OK' } } } },
    '/reports/dashboard': { get: { summary: 'Dashboard summary', responses: { 200: { description: 'OK' } } } },
    '/reports/arrears': { get: { summary: 'Arrears report', responses: { 200: { description: 'OK' } } } },
    '/webhooks/banks/coop/transactions': {
      post: {
        summary: "Co-op Bank's SendTransactionINS webhook (called by the bank, not the frontend)",
        security: [],
        responses: { 200: { description: 'Acknowledged' }, 401: { description: 'Invalid Basic credential' }, 422: { description: 'No recognizable AccountNumber in payload' } },
      },
    },

    // --- G5 M-PESA collection (authenticated) ---
    '/mpesa-collection/tenants/{tenantId}/account': {
      get: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Tenant account statement (charges, payments, credit)',
        parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 404: { description: 'Tenant not found' } },
      },
    },
    '/mpesa-collection/tenants/{tenantId}/payments': {
      get: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Tenant payments attributed via G5',
        parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/mpesa-collection/tenants/{tenantId}/link': {
      get: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Inspect safe metadata for the Tenant submission link',
        description: 'Requires MPESA entitlement and an administrative role. Never returns a bearer token, token digest or token envelope.',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'estateId', in: 'query', required: false, description: 'Select the estate tenancy/link context when the tenant has records in multiple estates; defaults to the Tenant estate pointer.', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
        ],
        responses: { 200: { description: 'Safe link metadata' }, 404: { description: 'No link' } },
      },
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Create a Tenant submission link or reuse the existing ACTIVE link',
        description: 'Requires CLIENT_OWNER, CLIENT_ADMIN or SUPER_ADMIN plus MPESA entitlement. Creates and queues the first protected onboarding message when no link exists. Reusing an ACTIVE link does not send another message; use /resend. Raw bearer token is never returned by the API.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'estateId', in: 'query', required: false, description: 'Select the estate tenancy/link context when the tenant has records in multiple estates; defaults to the Tenant estate pointer.', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
        ],
        responses: {
          201: { description: 'Link created and protected onboarding SMS queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/MpesaLinkIssueResponse' } } } },
          200: { description: 'Existing ACTIVE link reused; no additional SMS was sent', content: { 'application/json': { schema: { $ref: '#/components/schemas/MpesaLinkIssueResponse' } } } },
          409: { description: 'Concurrent conflict or link was revoked; use explicit rotation where authorized' },
          503: { description: 'Required protected outbox unavailable' },
        },
      },
    },
    '/mpesa-collection/tenants/{tenantId}/link/resend': {
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Queue a new delivery attempt for the existing Tenant payment link',
        description: 'Requires CLIENT_OWNER, CLIENT_ADMIN or SUPER_ADMIN plus MPESA entitlement. Sends the same URL with the same linkVersion in a new protected outbox attempt. A short resend throttle may return queued=false. It never rotates the token.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'estateId', in: 'query', required: false, description: 'Select the estate tenancy/link context when the tenant has records in multiple estates; defaults to the Tenant estate pointer.', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
        ],
        responses: {
          200: { description: 'Resend queued or throttled', content: { 'application/json': { schema: { $ref: '#/components/schemas/MpesaLinkResendResponse' } } } },
          404: { description: 'No active link' },
          503: { description: 'Required protected SMS prerequisites unavailable' },
        },
      },
    },
    '/mpesa-collection/tenants/{tenantId}/link/rotate': {
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Explicitly rotate a Tenant payment link for security',
        description: 'Requires CLIENT_OWNER, CLIENT_ADMIN or SUPER_ADMIN plus MPESA entitlement. The expectedLinkVersion must match the inspected current version. Rotation creates a new token/version and queues its protected delivery; the raw token is never returned.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'estateId', in: 'query', required: false, description: 'Select the estate tenancy/link context when the tenant has records in multiple estates; defaults to the Tenant estate pointer.', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MpesaLinkRotateRequest' } } },
        },
        responses: { 200: { description: 'Link rotated and protected delivery queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/MpesaLinkRotateResponse' } } } }, 409: { description: 'Expected link version is stale' }, 503: { description: 'Replacement link delivery could not be queued; rotation rolled back' } },
      },
    },
    '/mpesa-collection/tenants/{tenantId}/link/revoke': {
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Administratively revoke the Tenant submission link',
        description: 'Requires CLIENT_OWNER, CLIENT_ADMIN or SUPER_ADMIN plus MPESA entitlement. Revocation invalidates the current token version and cancels protected messages that have not started sending.',
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'estateId', in: 'query', required: false, description: 'Select the estate tenancy/link context when the tenant has records in multiple estates; defaults to the Tenant estate pointer.', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
        ],
        responses: { 200: { description: 'Revoked' }, 404: { description: 'Link not found' } },
      },
    },
    '/mpesa-collection/submissions': {
      get: {
        tags: ['G5 M-PESA Collection'],
        summary: 'List SMS submissions for review',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/mpesa-collection/submissions/{id}/evidence': {
      get: {
        tags: ['G5 M-PESA Collection'],
        summary: 'View retained original SMS evidence for an authorized review',
        description: 'Requires authenticated CLIENT_OWNER, CLIENT_ADMIN or SUPER_ADMIN with explicit client scope and MPESA entitlement. Decrypts the original SMS only for this request, records a required audit event, and returns Cache-Control: no-store. The plaintext is omitted from list responses and audit metadata. If raw evidence was not retained, available=false.',
        security: [{ cookieAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } }],
        responses: {
          200: { description: 'Evidence detail or an explicit unavailable state' },
          404: { description: 'Submission not found in the caller scope' },
          503: { description: 'Evidence cannot be decrypted or the audit write failed' },
        },
      },
    },
    '/mpesa-collection/submissions/{id}/resolve': {
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Manually resolve a submission in review',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Resolved' } },
      },
    },

    // --- G5 public submission (no cookie auth) ---
    '/public/mpesa/submissions': {
      post: {
        tags: ['G5 Public'],
        summary: 'Public Tenant SMS submission (bearer token in body)',
        description: 'Actual mount: POST /api/v1/public/mpesa/submissions (before CSRF). No cookie auth. 4KB body limit. Additional body fields rejected. Rate limited. Neutral responses for invalid/unknown/revoked links.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'text'],
                properties: {
                  token: { type: 'string', description: 'One-time bearer token from link issue/rotate' },
                  text: { type: 'string', description: 'Full M-PESA confirmation SMS text' },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          200: { description: 'Accepted or neutral rejection (indistinguishable to caller)' },
          429: { description: 'Rate limited' },
        },
      },
    },

    // --- Daraja webhooks (public; no invented auth) ---
    '/webhooks/daraja/c2b/confirm': {
      post: {
        tags: ['Daraja'],
        summary: 'Daraja C2B confirmation callback',
        description: 'Actual mount: POST /api/v1/webhooks/daraja/c2b/confirm. Public webhook. Do not invent Safaricom auth; handler persists then acknowledges when enabled.',
        security: [],
        responses: { 200: { description: 'Acknowledged' } },
      },
    },
    '/webhooks/daraja/c2b/validate': {
      post: {
        tags: ['Daraja'],
        summary: 'Daraja C2B validation callback',
        security: [],
        responses: { 200: { description: 'Acknowledged' } },
      },
    },
    '/webhooks/daraja/pull/results': {
      post: {
        tags: ['Daraja'],
        summary: 'Daraja transaction status / pull results callback',
        security: [],
        responses: { 200: { description: 'Acknowledged' } },
      },
    },
  },
};
