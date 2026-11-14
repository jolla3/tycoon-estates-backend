import { describe, test, expect } from '@jest/globals';
import { openApiSpec } from '../../../src/docs/openapi.js';

describe('G5 OpenAPI coverage', () => {
  test('documents authenticated collection routes', () => {
    expect(openApiSpec.paths['/mpesa-collection/tenants/{tenantId}/account']).toBeTruthy();
    expect(openApiSpec.paths['/mpesa-collection/tenants/{tenantId}/link'].post).toBeTruthy();
    expect(openApiSpec.paths['/mpesa-collection/submissions']).toBeTruthy();
  });

  test('public submission and Daraja webhooks declare security: []', () => {
    expect(openApiSpec.paths['/public/mpesa/submissions'].post.security).toEqual([]);
    expect(openApiSpec.paths['/webhooks/daraja/c2b/confirm'].post.security).toEqual([]);
    expect(openApiSpec.paths['/webhooks/daraja/c2b/validate'].post.security).toEqual([]);
    expect(openApiSpec.paths['/webhooks/daraja/pull/results'].post.security).toEqual([]);
  });
});
