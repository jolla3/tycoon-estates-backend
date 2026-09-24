// tests/helpers/csrf.js
// Extracts the csrf-token cookie value from a supertest response so tests
// can echo it back as the X-CSRF-Token header on subsequent
// state-changing requests — mirrors what a real browser-based frontend
// does (read the readable cookie, send it back as a header), rather than
// weakening CSRF protection to make tests pass.
export function extractCsrfToken(res) {
  const setCookie = res.headers['set-cookie'] || [];
  for (const cookie of setCookie) {
    const match = cookie.match(/csrf-token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}
