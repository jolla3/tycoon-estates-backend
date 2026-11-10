/**
 * Read-only validation of tenancy/account ledger running-balance transitions.
 *
 * Each ledger row is a directed edge from its implied prior balance to its
 * recorded running balance. Since createdAt/ObjectId are not a guaranteed
 * cross-process commit order, validate existence of one Euler trail from zero
 * rather than greedily choosing a chronological or locally unique next edge.
 * Parallel edges are intentional: two identical monthly charges are two
 * separate movements and must not be mistaken for an ambiguous history.
 */
const safeInteger = Number.isSafeInteger;
const sampleIds = (rows, limit = 8) => rows.slice(0, limit).map((row) => String(row._id ?? row.id ?? 'unknown'));

function addIssue(issues, type, payload) {
  issues.push({ severity: 'high', type, ...payload });
}

function accountKey(tenancyId, accountCategory) {
  return JSON.stringify([String(tenancyId), String(accountCategory)]);
}

/**
 * Return high-severity integrity findings for tenancy-scoped RENT/DEPOSIT
 * running-balance chains. Does not mutate input rows or database state.
 */
export function inspectLedgerBalanceChains(ledgers = []) {
  if (!Array.isArray(ledgers)) {
    throw new TypeError('inspectLedgerBalanceChains expects an array of ledger rows');
  }

  const issues = [];
  const groups = new Map();

  for (const row of ledgers) {
    if (!row?.tenancyId || !['RENT', 'DEPOSIT'].includes(row.accountCategory)) continue;

    const key = accountKey(row.tenancyId, row.accountCategory);
    if (!groups.has(key)) groups.set(key, []);

    const amount = row.amountCents;
    const running = row.runningBalanceCents;
    const prior = running - amount;
    if (!safeInteger(amount) || amount === 0 || !safeInteger(running) || !safeInteger(prior)) {
      addIssue(issues, 'invalid_ledger_amount_or_running_balance', {
        ledgerId: String(row._id ?? row.id ?? 'unknown'),
        amountCents: amount,
        runningBalanceCents: running,
        impliedPriorBalanceCents: Number.isFinite(prior) ? prior : null,
      });
      continue;
    }

    groups.get(key).push({
      id: String(row._id ?? row.id ?? 'unknown'),
      from: String(prior),
      to: String(running),
    });
  }

  for (const [groupKey, edges] of groups) {
    if (edges.length === 0) continue;

    // Directed degree counts retain parallel edges; adjacency is undirected
    // only for the weak-connectivity condition of Euler-trail existence.
    const vertices = new Map();
    const vertex = (balance) => {
      if (!vertices.has(balance)) {
        vertices.set(balance, { balance, inDegree: 0, outDegree: 0, neighbors: new Set() });
      }
      return vertices.get(balance);
    };

    for (const edge of edges) {
      const from = vertex(edge.from);
      const to = vertex(edge.to);
      from.outDegree += 1;
      to.inDegree += 1;
      from.neighbors.add(edge.to);
      to.neighbors.add(edge.from);
    }

    const start = vertices.get('0');
    const positive = [];
    const negative = [];
    const unexpected = [];

    for (const current of vertices.values()) {
      const delta = current.outDegree - current.inDegree;
      if (delta === 1) positive.push(current.balance);
      else if (delta === -1) negative.push(current.balance);
      else if (delta !== 0) unexpected.push({ balanceCents: Number(current.balance), degreeDelta: delta });
    }

    const allBalanced = positive.length === 0 && negative.length === 0 && unexpected.length === 0;
    const openTrail = positive.length === 1 && negative.length === 1
      && unexpected.length === 0 && positive[0] === '0';
    const closedTrailFromZero = allBalanced && Boolean(start) && start.outDegree > 0;

    if (!openTrail && !closedTrailFromZero) {
      const wrongStart = positive.length === 1 && negative.length === 1
        && positive[0] !== '0' && unexpected.length === 0;
      addIssue(issues, 'ledger_running_balance_chain_degree_mismatch', {
        tenancyAccount: groupKey,
        reason: wrongStart ? 'trail_does_not_start_at_zero' : 'directed_euler_trail_degree_conditions_failed',
        startBalancesCents: positive.map(Number),
        endBalancesCents: negative.map(Number),
        unexpectedDegreeDeltas: unexpected,
        edgeCount: edges.length,
        sampleLedgerIds: edges.slice(0, 8).map((edge) => edge.id),
      });
    }

    // All active vertices must be in the same weakly connected component as
    // zero. This catches detached cycles/segments while allowing repeated
    // transitions and multiple valid Euler-trail orderings.
    const reachable = new Set();
    if (start) {
      const queue = ['0'];
      reachable.add('0');
      for (let index = 0; index < queue.length; index += 1) {
        const current = vertices.get(queue[index]);
        for (const neighbor of current.neighbors) {
          if (!reachable.has(neighbor)) {
            reachable.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    if (!start || reachable.size !== vertices.size) {
      const disconnectedBalances = [...vertices.keys()].filter((balance) => !reachable.has(balance));
      const disconnectedSet = new Set(disconnectedBalances);
      const disconnectedEdges = edges.filter((edge) => disconnectedSet.has(edge.from) || disconnectedSet.has(edge.to));
      addIssue(issues, 'ledger_running_balance_chain_disconnected', {
        tenancyAccount: groupKey,
        reason: start ? 'detached_balance_component' : 'no_transition_from_zero_balance',
        reachableBalanceCount: reachable.size,
        totalBalanceCount: vertices.size,
        disconnectedBalanceSamplesCents: disconnectedBalances.slice(0, 8).map(Number),
        remainingLedgerIds: disconnectedEdges.slice(0, 8).map((edge) => edge.id),
      });
    }
  }

  return issues;
}
