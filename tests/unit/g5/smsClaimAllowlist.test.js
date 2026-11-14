import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('standard SMS claim allowlist', () => {
  test('does not use $ne G5_PROTECTED alone', () => {
    const src = readFileSync(join(here, '../../../src/services/sms.service.js'), 'utf8');
    expect(src).not.toMatch(/deliveryMode:\s*\{\s*\$ne:\s*'G5_PROTECTED'\s*\}/);
    expect(src).toContain("deliveryMode: 'STANDARD'");
    expect(src).toContain("dispatchMode: 'ENABLED'");
  });

  test('demo seed suppresses outbound SMS', () => {
    const src = readFileSync(join(here, '../../../scripts/seedDemoClient.js'), 'utf8');
    expect(src).toContain("status: 'cancelled'");
    expect(src).toContain("dispatchMode: 'SUPPRESSED'");
  });
});
