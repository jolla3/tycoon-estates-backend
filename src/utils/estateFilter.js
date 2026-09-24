// src/utils/estateFilter.js
//
// Every service that lists/reports data must filter by the estate scope
// clientContext.js actually enforced (req.estateFilter), not just the
// clientId. This is the single place that turns that value into a Mongo
// query fragment, so every service applies the SAME semantics:
//   - null            -> no estate restriction, don't add an estateId clause
//   - a single string  -> filter to exactly that estate
//   - an array         -> filter to exactly those estates ($in)
export function estateFilterClause(estateFilter) {
  if (!estateFilter) return {};
  if (Array.isArray(estateFilter)) return { estateId: { $in: estateFilter } };
  return { estateId: estateFilter };
}
