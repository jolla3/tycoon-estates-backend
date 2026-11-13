import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('submission acceptance fence contract', () => {
  test('submitSms uses same-document linkVersion CAS', () => {
    const src = readFileSync(join(here, '../../../src/services/mpesa/mpesaSubmission.service.js'), 'utf8');
    expect(src).toContain('submissionRevision');
    expect(src).toContain("status: 'ACTIVE'");
    expect(src).toContain('linkVersion: probe.linkVersion');
    expect(src).toContain('withTransaction');
    expect(src).toContain('acceptedLinkVersion');
    expect(src).toContain('acceptedAt');
  });

  test('link model exposes submissionRevision', () => {
    const src = readFileSync(join(here, '../../../src/models/MpesaSubmissionLink.js'), 'utf8');
    expect(src).toContain('submissionRevision');
  });
});
