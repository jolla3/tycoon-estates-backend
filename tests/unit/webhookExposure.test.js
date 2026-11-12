import '../setup.js';
import {
  isNonProductionLabOverrideEnabled,
} from '../../src/services/banking/bank.factory.js';

function exposureAllowed({ operationalReady, labOverride, nodeEnv = 'test' }) {
  return Boolean(
    operationalReady
    || isNonProductionLabOverrideEnabled(labOverride, nodeEnv)
  );
}

describe('Co-op webhook exposure gate', () => {
  test('defaults closed when not operational and lab is off', () => {
    expect(exposureAllowed({
      operationalReady: false,
      labOverride: false,
    })).toBe(false);
  });

  test('non-production lab override enables controlled exposure', () => {
    expect(exposureAllowed({
      operationalReady: false,
      labOverride: true,
      nodeEnv: 'test',
    })).toBe(true);
  });

  test('lab override cannot expose webhook in production', () => {
    expect(exposureAllowed({
      operationalReady: false,
      labOverride: true,
      nodeEnv: 'production',
    })).toBe(false);
  });

  test('operational readiness enables exposure without lab override', () => {
    expect(exposureAllowed({
      operationalReady: true,
      labOverride: false,
      nodeEnv: 'production',
    })).toBe(true);
  });
});
