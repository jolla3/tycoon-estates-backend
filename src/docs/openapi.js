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
    },
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'connect.sid' },
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
        summary: 'Preview billing SMS without sending',
        responses: { 200: { description: 'Preview message' } },
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
      post: { summary: 'Create a tenant', responses: { 201: { description: 'Created' } } },
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
        summary: 'Inspect the Tenant submission link (never returns the raw token)',
        parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 404: { description: 'No link' } },
      },
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Issue or rotate the Tenant submission link (raw token returned once)',
        parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Link + one-time token' }, 409: { description: 'Concurrent conflict' } },
      },
    },
    '/mpesa-collection/tenants/{tenantId}/link/revoke': {
      post: {
        tags: ['G5 M-PESA Collection'],
        summary: 'Revoke the Tenant submission link',
        parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Revoked' } },
      },
    },
    '/mpesa-collection/submissions': {
      get: {
        tags: ['G5 M-PESA Collection'],
        summary: 'List SMS submissions for review',
        responses: { 200: { description: 'OK' } },
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
