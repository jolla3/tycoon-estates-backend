/**
 * Checkpoint policy pure logic: any failed batch item blocks advance.
 * Full Mongo concurrency is covered in integration tests when available.
 */
describe('checkpoint failure policy', () => {
  function shouldFailPage(results) {
    return (results || []).some((r) => !r.ok);
  }

  test('all accepted — do not fail page', () => {
    expect(shouldFailPage([{ ok: true }, { ok: true, created: false }])).toBe(false);
  });

  test('invalid item among valid — fail page', () => {
    expect(shouldFailPage([
      { ok: true },
      { ok: false, code: 'INVALID_REQUEST', error: 'bad direction' },
    ])).toBe(true);
  });

  test('ownership conflict — fail page', () => {
    expect(shouldFailPage([{ ok: false, code: 'CONFLICT' }])).toBe(true);
  });

  test('empty results — do not fail', () => {
    expect(shouldFailPage([])).toBe(false);
  });
});
