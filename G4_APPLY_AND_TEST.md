# Applying the G4 Changes-Only Overlay

This archive is **not** a full repository. It contains only files **created or modified** for G4 relative to baseline:

`e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` (v2.0.3)

## 1. Inspect the destination repository

```bash
cd /path/to/tycoon-estates-backend
git status
git rev-parse HEAD
git log -1 --oneline
```

Prefer starting from the recorded baseline (or a compatible descendant that still contains the pre-G4 banking surface).

If you have uncommitted local work, stash or commit it before overlaying:

```bash
git status -sb
git stash push -u -m "pre-g4-overlay"
```

## 2. Apply files without losing unrelated work

Extract beside the repo, then copy paths explicitly (do **not** wipe the tree):

```bash
unzip G4-changes-handoff.zip -d /tmp/G4-changes-extract
# Archive root is G4-changes/ (or contents listed in G4_FILE_MANIFEST.txt)

cd /path/to/tycoon-estates-backend
# Preview:
while read -r kind hash path; do
  [ "$kind" = "NEW" ] || [ "$kind" = "REPLACE" ] || continue
done < /tmp/G4-changes-extract/G4-changes/G4_FILE_MANIFEST.txt

# Copy overlay (adjust path if extract layout differs):
rsync -a --exclude 'G4_FILE_MANIFEST.txt' --exclude 'G4_APPLY_AND_TEST.md' \
  /tmp/G4-changes-extract/G4-changes/ ./
```

Or copy each path from the manifest with `cp --parents`.

Review the diff before committing:

```bash
git status
git diff --stat
```

## 3. Install locked dependencies

G4 did **not** change `package.json` / `package-lock.json` relative to baseline. Use the existing lockfile:

```bash
npm ci
```

## 4. Required environment (disposable)

Do **not** use production URIs or real bank credentials.

Minimum for unit tests:

```bash
export NODE_ENV=test
export BANK_SECRETS_BACKEND=memory
export BANK_SECRETS_ALLOW_MEMORY=1
# Other vars as required by existing tests/setup (MONGODB_URI, REDIS_URL, COOKIE_SECRET, etc.)
```

Production-style secrets backend (optional local verification):

```bash
export BANK_SECRETS_BACKEND=redis
export REDIS_URL=redis://127.0.0.1:6379
```

Co-op webhook lab exposure (default off):

```bash
export COOP_WEBHOOK_LAB_OVERRIDE=1   # only for controlled lab
```

## 5. Unit tests

From `package.json`:

```bash
NODE_OPTIONS=--experimental-vm-modules npm test -- --runInBand
```

G4-focused patterns:

```bash
NODE_OPTIONS=--experimental-vm-modules npm test -- --runInBand \
  --testPathPattern='bankConnection|bankAccount.connection|bankFactory|bankRegistry|normalizedTransaction|bankTransaction.schema|secretsManager|bankSync.checkpoint|estateReassignment|webhookExposure|providerAdapters|syncCoordination'
```

## 6. MongoDB integration tests

`tests/integration/g4.concurrency.test.js` runs only when a disposable URI is set and does not look like production:

```bash
export G4_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_g4_test'
# or MONGODB_URI for the same purpose if your setup already uses it

NODE_OPTIONS=--experimental-vm-modules npm test -- --runInBand --testPathPattern=g4.concurrency
```

If the URI is missing, those tests **skip** (not pass).

## 7. Migration dry-run

```bash
node scripts/migrations/20261111_g4_bank_connection_indexes.js
node scripts/migrations/20261111_g4_bank_connection_account_fields.js
node scripts/migrations/20261111_g4_bank_transaction_provenance.js
node scripts/migrations/20261111_g4_bank_sync_and_quarantine.js
```

Execute only against disposable DBs:

```bash
EXECUTE=1 MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_g4_mig' \
  node scripts/migrations/20261111_g4_bank_connection_indexes.js
```

## 8. Interpreting results

| Outcome | Meaning |
|---------|---------|
| Jest reports tests passed | Assertions executed and passed |
| `describe.skip` / skipped | Environment gate (e.g. no Mongo URI) — **not** a pass |
| `jest: not found` / install failure | Tests **could not execute** |
| Migration dry-run prints plan only | No DB writes (`EXECUTE` not set) |

Do not treat “tests not run” as success.

## 9. Safety reminders

- G3 remains the financial authority; do not point tests at production data.
- Memory secrets backend is not multi-instance safe.
- Co-op AccountTransactions **list** polling remains disabled until its own contract is verified.
- KCB / EQUITY / NCBA adapters remain non-operational shells.
