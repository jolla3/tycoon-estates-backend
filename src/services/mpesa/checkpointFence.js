// Pure fence check — no environment or database imports.
export function checkpointAdvanceSucceeded(updated) {
  return Boolean(updated);
}
