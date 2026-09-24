import '../setup.js';
import { generateMessageReference } from '../../src/services/banking/providers/coop/coop.client.js';

describe('generateMessageReference (documented constraint: 1–27 characters)', () => {
  test('produces a reference within the documented length bounds', () => {
    const ref = generateMessageReference();
    expect(ref.length).toBeGreaterThanOrEqual(1);
    expect(ref.length).toBeLessThanOrEqual(27);
  });

  test('produces a different value each call (avoids accidental replay of the same MessageReference)', () => {
    const a = generateMessageReference();
    const b = generateMessageReference();
    expect(a).not.toBe(b);
  });
});
