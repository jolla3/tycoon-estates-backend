# G5.2 — Tenancy Link and Protected Notification Lifecycle

**Status:** Independent verdict: APPROVE WITH REQUIRED CHANGES. The documentation resolution is recorded in §16. This remains design-only; no application code, model, migration, index, route, worker, credential or runtime change is authorized.  
**Source baseline:** `main@204c8f9c3578f753af20727799aaa049b1545135` (12 November 2026).  
**G5 documentation baseline:** `feature/g5-construction@c89468df634e4b2d51ee67c660d89faffd470e5e`.  
**Dependencies:** G5.1 five-record schema proposal; G5-B01/B03 merchant identity and operational enablement; G5-B05 inbound evidence retention/access policy; G5-B08 Celcom ambiguous-send resolution; G5-D14 dispatch latency/SLA; G5-D15 tenancy lifecycle and seed policy; G5-D17 protected outbound payload retention.

## 1. Purpose and non-goals

G5.2 defines how a G3 Tenant/Tenancy lifecycle operation may create, rotate, revoke or preserve a private M-PESA submission link, and how the corresponding bearer-link SMS is durably queued without exposing its contents.

This design preserves these boundaries:

- G3 remains the authority for Tenant, Tenancy, House occupancy, Payment, allocation and Ledger state.
- A link binds to one immutable `{ clientId, estateId, tenantId }` Tenant identity. It is not bound to one House or Tenancy and is never reassigned to another Tenant.
- Buy Goods / Till only. PayBill and G4 bank flows are unchanged.
- The existing Celcom provider abstraction and SMS queue remain the delivery boundary. No second SMS queue, provider, event bus or delivery platform is introduced.
- No Celcom call occurs inside a MongoDB transaction.
- This phase does not design the public submission route/parser, Daraja integration, Pull checkpoint, MPESA posting, or merchant credential storage.

## 2. Verified source baseline

The following are source observations, not implemented G5 behaviour:

| Area | Verified source observation | G5.2 consequence |
|---|---|---|
| Tenant creation | `tenantService.create()` starts a Mongo session and creates Tenant plus `tenancyService.open()` in the same `withTransaction()` callback. | Link and protected outbox can join the existing session at the top-level create use case. |
| Low-level Tenancy open | `tenancyService.open()` accepts an outer session, but is also called directly by `scripts/seedDemoClient.js`. | Do not make every low-level `open()` call implicitly create a G5 link or send SMS. Provisioning must be an explicit top-level lifecycle decision. |
| House move | `tenancyService.moveToHouse()` owns a transaction that closes the old Tenancy, updates House pointers, creates a new Tenancy and updates Tenant. It does not accept an outer session. Its old-House pointer-clear filter matches only House ID/client, not expected old `tenantId`. | Refactor transaction ownership and add an exact `{ _id, clientId, tenantId: expectedTenantId }` pointer compare before clearing. Require the request's `expectedTenancyId` for the exact unit being moved; a stale move must return conflict without acting on another active tenancy. |
| Move-out update | `tenantService.update(status='moved_out')` first updates Tenant outside a transaction, then calls `tenancyService.close()` separately. If it cannot find the old Tenant as the active occupant of mutable `Tenant.houseId`, its fallback unconditionally clears the House pointer/status; a stale request can therefore clear a later occupant. | Replace the split flow. Require the exact expected Tenancy ID from the caller, query by client + tenant + expected tenancy, and never clear House pointers unless the House still points to that exact tenant. A stale request must not act on a later occupancy. |
| Close helper | `tenancyService.close()` accepts an outer session and updates Tenancy, House and Tenant together when supplied. | Reuse this domain operation in the unified move-out transaction; do not duplicate the close logic. |
| Controller actor propagation | `tenantService.create()` and `tenantService.moveToHouse()` accept actor IDs, but the inspected tenant controller does not pass the current authenticated user. The move-out update signature also has no actor parameter. | Propagate an explicit lifecycle actor/context from each authenticated controller into the use case so Tenancy actor fields and in-transaction audit records identify the initiator. |
| Active Tenancies in API DTO | `tenantService.get()` resolves one active Tenancy through the Tenant's singular House pointer and does not expose all Tenancies. | Add `activeTenancies[]` to the authenticated Tenant DTO, with each exact Tenancy/House/Estate and tenancy-scoped financial context. Move/move-out requests must identify the exact Tenancy they intend to change. |
| Destination House pointer | `tenancyService.moveToHouse()` checks for an active target Tenancy but does not reject a conflicting non-null `newHouse.tenantId` pointer when no active target Tenancy is found. | Require the target House pointer to be vacant and consistent before assigning it. Any active Tenancy or conflicting pointer causes a conflict; never overwrite it as a cleanup step. |
| SMS enqueue | `smsService.queueSms()` uses `withIdempotency()` and `SmsMessage.create()` without a session. `withIdempotency()` is read-before-create and has no session argument. | Do not call the existing helper unchanged. Add a reviewed session-aware enqueue path using the caller's session and the existing unique idempotency key. |
| SMS contents | `SmsMessage.message` is plaintext; tenant detail and SMS history expose it. `phoneNumber` is also returned. | Neither the bearer URL nor its actual destination/body may be stored in ordinary readable fields for G5 messages. |
| SMS worker | `_claimNextBatch()` claims only `queued` rows and changes them to `processing`; no stale-processing reclaimer was found. | Add a durable fenced lease and safe crash recovery for G5-protected dispatch. |
| Provider semantics | Celcom acceptance returns a message ID; network/no-response and 5xx outcomes are `unknown`, not retried. 4xx/provider rejection is `failed`. The adapter currently returns `retryable: false`. `smsService` passes `idempotencyKey` as a third argument, but `CelcomProvider.send(mobile, message)` accepts only two parameters; the key is ignored and no provider-side idempotency is established. | Treat `sent` as provider acceptance, not handset delivery. The DB key can deduplicate outbox rows only; it does not make the Celcom HTTP request idempotent. Do not retry `unknown`. Do not invent a Celcom delivery lookup or idempotency contract. |
| Scheduler | `smsReminderJob()` drains the global SMS queue every 15 minutes under the API-process scheduler/Redis lock. It is not a dedicated SMS worker. | Fifteen minutes is existing cadence, not an approved onboarding delivery SLA. G5-D14 must set a target before release. |
| Encryption | `src/utils/encryption.js` uses AES-256-GCM but its envelope has no key ID/version or AAD. The stronger keyring/AAD implementation in `banking/secretsManager.js` is bank-specific. | Do not reuse the legacy helper unchanged or reuse bank credential models/keyring. Design a dedicated, versioned G5 outbox envelope. |
| Audit | `audit()` in `audit.service.js` does not accept a Mongo session and catches/logs failures. `AuditLog` itself is a normal Mongoose model. | Critical G5 link/outbox lifecycle audit must be written directly with the same session and allowed to abort the transaction on failure. Never put secrets in metadata. |
| Demo seed | `seedDemoClient.js` describes its sample SMS as “not sent” but inserts it with `status: 'queued'`. The scheduled SMS drain selects queued messages. | This is a real no-send defect: demo messages are eligible for Celcom dispatch. Seed records must be explicitly suppressed and excluded by the worker. |
| SMS idempotency index | `SmsMessage.idempotencyKey` is declared required/unique in the Mongoose schema; actual live index presence was not inspected in this design pass. | Inspect exact live `smsmessages.idempotencyKey` index and duplicate data before relying on it as the protected outbox collision barrier. Do not assume the schema declaration proves live DB readiness. |

GitHub code search returned no indexed call-site results in this pass (`incomplete_results` was true). The controllers, tenancy/tenant services, house/deposit/transaction services, routes, seed script and repository tree were inspected; no other direct production Tenancy create/status writer was identified in those inspected paths. This is not proof that no such caller exists. Re-run a complete repository-wide call-site search at the implementation HEAD before changing lifecycle ownership.

## 3. Lifecycle provisioning policy

A link is created only when the top-level lifecycle use case explicitly requests G5 provisioning. Do not infer provisioning from the mere existence of any merchant profile, and never accept a merchant/profile choice from the public tenant or payer.

The design exposes two trusted server-side modes:

- `DISABLED`: normal G3 Tenant/Tenancy create or move proceeds without creating a new G5 link or outbox item. This is the safe default while the estate/Till mapping or merchant capability is not operational. If an old G5 link already exists for the Tenancy being closed/transferred, its lifecycle state must still be transitioned atomically; DISABLED never means leaving an existing link ACTIVE after its Tenancy closes.
- `REQUIRED`: the operation must create the tenancy link and protected outbox atomically. The server resolves exactly one permitted and operational merchant profile from verified ownership mapping. If mapping is missing, ambiguous, disabled, or the protected-payload encryption key is unavailable, abort the complete lifecycle transaction. Do not commit a Tenant/Tenancy and silently omit the required link or notification.

This mode is a trusted application/configuration decision, not a request-body field. The actual configuration location and owner-facing enable/disable UX remain PROPOSED and require review. G5-B01/B03 still block the definition of a real operational Till/Store mapping and provider capability. No placeholder Till number or guessed payment instruction is allowed.

## 4. Link creation and token lifecycle

### 4.1 Create

For a G5-provisioned Tenant create:

1. Before entering the retryable transaction callback, allocate stable `_id`s for the Tenant, Tenancy, SubmissionLink and SmsMessage; generate a 32-byte CSPRNG bearer token, calculate its SHA-256 digest, set token/notification versions, derive the attempt-scoped outbox idempotency key and pin the currently approved G5 outbox key ID/version. Load the required key material before opening the transaction; do not perform a KMS/network lookup in the callback. The preallocated Tenant/Tenancy/link/message IDs are used in the envelope AAD. Keep the raw token only in process memory long enough to construct and encrypt the body. The G3 lifecycle services must accept these preallocated IDs without generating replacements on each callback retry.
2. Start the existing Tenant/Tenancy transaction. Re-read and validate the House, Estate, Tenant ownership and server-resolved merchant mapping using the same session. Do not trust a stale pre-transaction House read as the final ownership check.
3. Create Tenant and exact ACTIVE Tenancy using the existing G3 services and session.
4. Create one `MpesaSubmissionLink` bound to the immutable `clientId`, `estateId`, and `tenantId` identity. Store only the token digest/version; never persist the raw bearer token. The link is not bound to a particular House/Tenancy.
5. Resolve the outbound Till instructions/body from the merchant profile and tenancy snapshot read in this transaction. Build the protected SMS row with the same preallocated `SmsMessage._id` and stable `idempotencyKey`. Generate a fresh cryptographically random GCM nonce and encrypt the payload in this callback invocation, using the pinned key version and the canonical AAD. If MongoDB retries the callback, generate a new nonce and envelope for that attempt; never reuse a GCM nonce with the same key across attempts. Only the envelope written by the transaction that successfully commits can be dispatched. The G5 `idempotencyKey` is deterministically derived from canonical `linkId`, `tokenVersion`, `notificationVersion` and the preallocated `SmsMessage._id` used as this delivery-attempt identity (for example, SHA-256 of a canonical tuple). It is not the generic `forceResend` helper and does not rely on mutable phone/period fields. A Mongo transaction retry reuses the same message ID/key; rotation or a separately authorized post-B08 retry creates a new message ID and new key. This key prevents duplicate outbox records for the same prepared attempt only; the Celcom provider does not consume it.
6. Write the critical lifecycle audit event using `AuditLog.create(..., { session })` or an equivalent session-aware method that propagates failure. Metadata may contain IDs, action, token version and outbox ID; never token, link URL, plaintext body, ciphertext, key material or raw SMS.
7. Commit. Only after commit may the existing scheduler-driven SMS dispatcher claim and send the protected outbox row.

If any database step fails, Tenant, Tenancy, link, outbox and critical audit row all roll back. In `DISABLED` mode a new tenancy receives no new G5 link/outbox; if an old link exists for a tenancy being closed/transferred, its lifecycle transition still occurs in that same transaction.

### 4.2 API precondition contract

The current authenticated tenant detail service uses the active Tenancy internally but does not return its ID. Add `activeTenancies[]` to the authorized Tenant detail DTO, sourced from every `{ clientId, tenantId, status: ACTIVE }` record and cross-checked against each House pointer. Do not select one convenient current Tenancy when multiple active units are permitted. Controllers must propagate authenticated actor IDs to create/move/move-out lifecycle service methods; the current create/move controllers omit available actor parameters, and move-out has no actor parameter.

- House move requests require `expectedTenancyId` and `newHouseId`; the expected ID identifies the one occupancy being moved, not the Tenant's only active occupancy.
- Move-out requests require `expectedTenancyId` (the same current active Tenancy identity).
- These IDs are optimistic concurrency preconditions, not authorization. Always re-check client/tenant/estate ownership and active status inside the Mongo transaction.
- Missing expected Tenancy IDs are rejected for move/move-out; do not silently fall back to a mutable House pointer.

### 4.3 Move

A move is one lifecycle transaction. Refactor `tenancyService.moveToHouse()` to accept a caller-owned session or move the transaction boundary into one shared lifecycle use case; do not nest independent transactions. The move request must include `expectedTenancyId` (the ACTIVE Tenancy the caller intends to move). In the transaction, re-read exactly `{ _id: expectedCurrentTenancyId, clientId, tenantId, status: ACTIVE }`; if it does not match, return a conflict without selecting a different current Tenancy. After moving, a replay of the old request must not move the tenant again; it may return a conflict requiring the client to refresh. A new move uses the new current Tenancy ID.

The existing `SmsMessage.idempotencyKey` schema declaration is unique, but G5.2 must inspect the exact live `smsmessages` index and duplicate state before using it as the outbox uniqueness barrier. The unique link-per-Tenancy index from G5.1 must also pass runtime readiness.

Within that one session:

1. Resolve and validate the Tenant, the exact ACTIVE Tenancy named by `expectedCurrentTenancyId`, destination House and destination merchant mapping. Reject a stale/mismatched expected tenancy; never silently substitute whichever active tenancy is now found for that Tenant. Query all ownership by client and expected tenant scope.
2. If the destination House is the same as the current House, preserve the existing no-op behaviour. Do not rotate the link, create another link, or queue another SMS. Otherwise require destination `House.tenantId` to be null and no ACTIVE Tenancy to exist for that House; a non-null pointer or active Tenancy is a conflict even if its ownership appears to match.
3. Close the exact old Tenancy and release its House pointer only through a conditional House update matching `{ _id: oldTenancy.houseId, clientId, tenantId: tenant._id }`. Require `matchedCount === 1`; if the pointer does not match, abort and require review; never clear a different occupant.
4. If an Tenant-level G5 link exists, retain the same link when one Tenancy closes or transfers. Do not transition the whole link merely because one unit closes if another ACTIVE Tenancy remains. Resolve old-Tenancy arrears as obligations in the Tenant's aggregate account and preserve their exact Tenancy IDs. Do not infer `SETTLED` from a zero projection; B07 remains unresolved.
5. Create the new ACTIVE Tenancy, update the destination House and Tenant pointers, then retain the existing Tenant-level link. Create the link/outbox only for the Tenant's first G5-provisioned Tenancy when trusted provisioning mode is `REQUIRED` and the destination merchant mapping is unambiguous and operational. Resolve Till instructions from the session-read destination profile and build the encrypted payload with a fresh GCM nonce in this callback attempt, using the same preallocated IDs/token/key version across callback retries.
6. Write the audit events in the same session and commit once.

If `REQUIRED` provisioning cannot resolve the destination merchant or write the outbox, the entire move rolls back. If provisioning is `DISABLED`, the normal G3 move proceeds without creating a new G5 link/outbox; any existing old link still receives the mandatory lifecycle transition in the same transaction. A move must never leave the old Tenancy closed while the new Tenancy lacks the explicitly required new link/outbox.

### 4.4 Move-out / close

Refactor `tenantService.update(status='moved_out')` so the Tenant status change, Tenancy close, House pointer update, old-link transition and critical audit event share one Mongo transaction. The current `findOneAndUpdate()` before `tenancyService.close()` is the split-write defect and must be removed from this path. The request must include `expectedTenancyId` for the ACTIVE occupancy it is closing; the server must not infer the target from mutable `Tenant.houseId` alone.

Use `tenancyService.close(..., { session })` to preserve its existing transactional Tenancy/House/Tenant behaviour, but strengthen it to require the exact expected Tenancy ID and exact House pointer compare with `matchedCount === 1`. Resolve the active Tenancy by exact `clientId`, `tenantId` and `expectedTenancyId`; do not use an unscoped current-House pointer as proof. If the House pointer or active Tenancy conflicts with the expected Tenant, stop for controlled review rather than clearing another occupant's pointer. The current fallback that unconditionally writes `{ tenantId: null, status: vacant }` when no matching active tenancy is found must be removed; a later occupant's pointer is never a cleanup target.

If the exact expected Tenancy is already `CLOSED` with `closeReason: MOVE_OUT`, treat the same request as an idempotent no-op success: do not write Tenant/House/link state again, even if that Tenant/House now has a later active occupant. This is critical: do not execute the old fallback that unconditionally sets House `tenantId: null` when the expected old Tenancy is absent/inactive. If it is closed for another reason (for example `TRANSFER`), or the expected ID belongs to another tenant/client, return conflict/not-found; do not close a newer active Tenancy. If no expected Tenancy exists, never clear House pointers. Any old link remains tied to its old Tenancy and follows the `ARREARS_ONLY`/B07 rule.

### 4.5 Void and administrative correction

No dedicated Tenancy void service/route was identified in the inspected baseline. Do not invent one in G5.2. Any future void/correction path must include the link transition and immutable before/after audit record in the same transaction. A VOID tenancy is never automatically postable; use `MANUAL_REVIEW` or an explicitly approved revocation state until the correction is resolved.

## 5. Rotation and revocation

- Rotation changes the bearer secret, not the link-to-Tenancy association. Replace `tokenHash`, increment `tokenVersion`, and record actor/time in one conditional update on the link document.
- Revoke requires `expectedTokenVersion` and changes link status/version using a conditional update on the same document. Redemption must fail immediately once the rotation/revocation transaction commits. A stale revoke request must conflict rather than alter a later-rotated link.
- Submission-vs-rotation/revocation must serialize through the write-bearing link CAS already required by G5.1. A read-only token/version recheck is insufficient.
- Rotation requires `expectedTokenVersion`; conditionally match the current link `_id`, status and token version, then replace `tokenHash`, increment `tokenVersion`, and create the new protected outbox item in the same transaction. Preallocate the new token, message ID and idempotency key before the callback; create the envelope with a fresh nonce inside each callback attempt using a pinned key version. Cancel queued old-version outbox rows and any claimed-but-not-send-started rows. A replay with a stale expected token version must conflict and must not create another message.
- On revocation, cancel queued and claimed-but-not-send-started outbox rows. Do not send a replacement.
- An external request that has crossed the durable `sendStartedAt` boundary cannot be recalled. A rotation/revocation immediately invalidates the old token for redemption, but a message already in flight may still be accepted/delivered with a now-invalid URL. Record this as an explicit race; do not delay emergency token invalidation to wait for Celcom.
- Do not automatically resend a previous unknown message with the same or a new secret. B08 requires a provider-status capability or controlled operator resolution before any retry is allowed.

## 6. Protected SMS record design

### 6.1 Reuse the current SMS queue

Extend the existing `SmsMessage` record and `smsService` worker path. Do not introduce a second queue/provider system or make `MpesaNotificationOutbox` a sixth G5 model without evidence that the existing collection cannot safely support the required isolation.

Proposed `SmsMessage` additions (all PROPOSED, not existing):

| Field | Purpose |
|---|---|
| `deliveryMode` | `STANDARD` or `G5_PROTECTED`; distinguishes plaintext legacy messages from encrypted G5 payloads. |
| Existing `type` enum | Add `g5_onboarding_link` as an explicit SMS message type; do not overload `general` or `payment_confirmation`. Update the `NOTIFICATION_VERSIONS` constant for this type. |
| Existing `notificationVersion` | Set `g5_onboarding_link:v1` for the initial approved body template. Persist it so later template changes do not rewrite the meaning of historical rows. |
| `dispatchMode` | `SEND` or `SUPPRESSED`; makes demo/test no-send intent explicit. Existing legacy rows without the field must retain their documented compatibility behaviour. |
| `status` enum additions | The pinned `SmsMessage` schema currently permits only `queued`, `processing`, `sent`, `failed` and `unknown`. Extend the strict enum with `cancelled` and `suppressed` before inserting either value. They are terminal non-dispatch states; never insert an unsupported value or disguise suppression as `failed`/`sent`. |
| `protectedPayload` | Versioned authenticated-encryption envelope containing destination phone and complete outbound body. `select:false` by default. |
| `protectedPayloadVersion` / envelope `formatVersion` | Enables authenticated envelope/key rotation and strict decoding. |
| `linkId`, `tokenVersion` | Immutable G5 association/version metadata used for dispatch eligibility and cancellation; not a bearer secret. |
| `dispatchLeaseToken`, `dispatchLeaseExpiresAt` | Random fencing token and expiry for the current dispatcher claim. |
| `sendStartedAt` | Durable boundary written immediately before the external provider call. Null means no external send was started by that claim. |
| Existing `sentAt` | Reuse this field as the timestamp when Celcom returned an accepted response with message ID. This is not proof of handset delivery. |

For `G5_PROTECTED` messages, ordinary `message` must contain only a fixed non-secret placeholder. Ordinary `phoneNumber` must not contain the full destination; retain a safe masked/redacted value. The actual destination and full body, including the bearer URL, live only inside `protectedPayload`.

### 6.2 Envelope and key custody

Use a dedicated G5 outbox encryption envelope; do not use the current `encryptionUtil.encrypt()` unchanged because it has no key ID/version or authenticated associated data. Do not reuse the bank-only `BankCredential` model or bank secrets manager.

Proposed envelope shape:

- format identifier and format version;
- algorithm identifier `aes-256-gcm`;
- key ID derived from the configured key, not the key itself;
- fresh 96-bit IV/nonce;
- 128-bit authentication tag;
- ciphertext containing JSON `{ recipient, message }`.

Authenticate associated data derived from a canonical encoding of `SmsMessage._id`, `clientId`, `estateId`, `tenantId`, `houseId`, `linkId`, `tokenVersion`, `deliveryMode`, `dispatchMode`, `type`, `notificationVersion`, `idempotencyKey`, envelope `formatVersion`, and `keyId`. Mutable state such as delivery `status` and lease expiry is not part of the AAD. Reject decryption if ownership, association or version metadata does not match. Key material must be provided through a dedicated G5 outbox keyring/config path, held outside MongoDB, with current/previous read support during planned rotation. Do not fall back to `ENCRYPTION_KEY`, bank encryption keys, or plaintext.

The exact environment variable names, key rotation procedure, startup/feature readiness behaviour and encrypted-payload retention period remain PROPOSED pending security/operations review. If protected encryption is unavailable or authentication fails, G5 provisioning/dispatch fails closed. Never log plaintext, token, ciphertext, IV/tag, key ID where it can enable correlation beyond operational need, or provider request body.

### 6.3 Read/API/history redaction

- `protectedPayload` must be excluded from default model selection and removed by serialization transforms.
- `smsService.history()`, `tenantService.get()` and any admin listing must return an explicit allowlist. Do not serialize raw SmsMessage documents for G5 records.
- The public/tenant history display must not show bearer links, ciphertext or the full protected body. A masked phone display is acceptable if product requires it.
- Audit metadata may include the link ID, tenancy ID, message ID, version and lifecycle action. It may not include the token, URL, destination body, ciphertext, key or raw confirmation SMS.
- The dispatcher explicitly selects the protected envelope, decrypts only immediately before sending, and clears plaintext buffers/references as soon as practical. No plaintext should be copied into logs, exceptions or audit fields. The protected branch must never fall back to `SmsMessage.message` or `phoneNumber`; missing/invalid envelope means fail closed without provider invocation.
- Retain encrypted outbox material only as long as needed for safe dispatch/reconciliation and the approved policy. Clear it after confirmed provider acceptance when the recovery policy permits. Unknown-outcome retention and final deletion timing remain blocked by D17 and B08; do not add a TTL or invent a duration here. B05 continues to govern inbound SMS/payer evidence.

### Proposed MpesaSubmissionLink dispatch fence field

Add `dispatchRevision: Number`, default `0`, to the proposed `MpesaSubmissionLink` schema. It is a write-fence/CAS revision incremented only when a protected SMS worker authorizes the provider-send boundary for the exact current `tokenVersion`. It is not the submission idempotency key, does not change the link's tenancy association, and requires no index. This is a new proposed field beyond the G5.1 core snapshot; include it only because the G5.2 dispatch-vs-rotation race has a concrete consumer.

## 7. Dispatcher claim, lease and crash recovery

The existing scheduler-driven SMS drain remains the only dispatcher and the same `SmsMessage` collection remains the only queue. `processQueuedBatch()` must partition its atomic claim queries by delivery mode: the legacy standard branch claims only `status: queued`, with `deliveryMode` either absent (legacy) or exactly `STANDARD`, and `dispatchMode` either absent (legacy) or exactly `SEND`, while the protected branch claims only `status: queued`, exact `deliveryMode: 'G5_PROTECTED'` and exact `dispatchMode: 'SEND'`. A protected row with missing or malformed dispatch mode is ineligible. A `G5_PROTECTED` row must never be returned by the legacy plaintext `phoneNumber`/`message` send branch. The protected path requires a durable lease and fencing token; a Redis scheduler lock alone is not enough.

Proposed transition model:

| Current state | Event | Next state | Rule |
|---|---|---|---|
| `queued` | Worker claim succeeds | `processing` | Atomic claim writes a fresh random `dispatchLeaseToken`, `dispatchLeaseExpiresAt`, and `processingStartedAt`. |
| `processing`, no `sendStartedAt` | Worker revalidates link/version and decrypts successfully; write-bearing start CAS succeeds with current unexpired lease | `processing` with `sendStartedAt` | This durable write is the external-side-effect boundary. The same Mongo transaction matches `_id`, `status: processing`, current `dispatchLeaseToken`, `dispatchLeaseExpiresAt > now`, and null/missing `sendStartedAt`; it also conditionally writes the link document using exact link ID/version/eligible status and increments `dispatchRevision`. Rotate/revoke races serialize against dispatch authorization. If the lease is expired or the row/link/version is no longer current, the CAS matches zero and no provider call is made. |
| `processing`, no `sendStartedAt` | Lease expires or worker crashes | `queued` or `cancelled` | Reclaim is safe because the provider call was not started. Requeue only if the link is still eligible at the same version; otherwise cancel. Issue a new lease token. |
| `processing`, `sendStartedAt` present | Celcom returns accepted + provider message ID | `sent` (provider accepted) | Update only when the current dispatch lease token matches. Record provider ID/time; do not claim handset delivery. |
| `processing`, `sendStartedAt` present | Celcom definitively rejects before accepting | `failed`, or retry only when adapter contract explicitly proves non-acceptance and `retryable:true` | Existing Celcom source currently returns `retryable:false`; do not invent retry capability. |
| `processing`, `sendStartedAt` present | Network timeout, no response, 5xx, process crash, or lease expires while request may be in flight | `unknown` | Never automatically requeue. Preserve the attempt `dispatchLeaseToken` as its identity. A late Celcom response may change `unknown` to `sent`/`failed` only if it still matches the same attempt token and no operator/new attempt has replaced it. |
| Any pre-send state | Link rotated/revoked or version no longer current | `cancelled` | Do not dispatch stale queued content. Redemption invalidation is authoritative even if an old SMS later arrives. |
| Seed/test fixture | Explicit no-send policy | `suppressed` / `dispatchMode: SUPPRESSED` | Must never be returned by the live dispatch claim query. |

The queue must claim each item with one atomic conditional update. Completion, failure, renewal and reclaim must match the current `dispatchLeaseToken`. A stale worker must not overwrite a newer worker's status. The transaction that writes `sendStartedAt` must perform a write-bearing conditional update on the `MpesaSubmissionLink`, incrementing `dispatchRevision` and matching the exact link ID, token version and eligible status; the SMS update must also match `status: processing`, the current lease token, `dispatchLeaseExpiresAt > now`, and null/missing `sendStartedAt`. Both writes occur in the same Mongo transaction. A read-only status/version check is not a concurrency fence. `dispatchRevision` is a new PROPOSED field because G5.2 now has a demonstrated dispatch-start CAS consumer; it is not an existing source field.

There is an unavoidable boundary between committing `sendStartedAt` and performing the HTTP request. A crash in that gap is conservatively `unknown`, even if the HTTP request was never made. That sacrifices an occasional resend for the more important guarantee that an already-accepted link SMS is not blindly duplicated. If the lease expires while the provider call is still in flight, the reclaimer may mark the row `unknown` but must preserve that attempt token; a late accepted/rejected response may settle the same attempt only while the token still matches. A later authorized recovery/new attempt must use a new token so a stale response cannot overwrite it. A rotation after `sendStartedAt` may invalidate the URL before Celcom delivers it; the old URL remains nonredeemable. This is a usability/recovery case, not permission to keep the old token valid.

Lease duration must exceed the configured provider request timeout plus dispatch/DB completion margin and must be renewable only while the worker still owns its token. Do not invent a lease duration here; set it from the actual Celcom timeout, shutdown behaviour and measured worker latency. The current provider timeout is configured as 15 seconds in the adapter source; that is an input to the later operational setting, not the complete lease duration by itself.

### 7.1 Exact claim predicates and expired-lease recovery

The claim filters in §7 are normative. The standard branch is a positive allowlist: deliveryMode and dispatchMode must each be absent (legacy row) or exactly STANDARD and SEND respectively; explicit nulls and malformed values are excluded. The protected branch requires exact deliveryMode G5_PROTECTED and dispatchMode SEND; missing or malformed protected dispatch mode is not eligible.

For a protected row whose lease expires before send-start, the reclaimer must match status processing, deliveryMode G5_PROTECTED, dispatchMode SEND, the exact dispatchLeaseToken, dispatchLeaseExpiresAt <= now, and sendStartedAt null/missing. It revalidates exact linkId, tokenVersion and eligible link state. A still-current row may return to queued with the old lease fields cleared; the next claimant generates a new lease token. A stale/rotated/revoked link makes the row cancelled. The later send-start transaction must independently repeat its write-bearing link/version CAS.

If an expired protected row has a non-null sendStartedAt, the reclaimer CASes processing to unknown only when the exact current lease token and expired time still match. It preserves the attempt token so a late response from that same provider call can settle the row. It never requeues the row. An operator-authorized future attempt, if B08 permits one, receives a new attempt identity/token.

A crash after committing sendStartedAt but before issuing the HTTP request is still unknown. This deliberate conservative boundary avoids duplicate sends when the provider outcome cannot be established. A Redis scheduler lock is not a substitute for the database lease or conditional writes.

### 7.2 Revision semantics

- submissionRevision is the accepted-submission write fence. The submission transaction increments it when it writes the same link record that rotation/revocation must update.
- dispatchRevision is the send-start write fence. The dispatcher reads its observed value and conditionally increments it in the same transaction that writes sendStartedAt. It is not a submission revision, token version or retry counter.
- tokenVersion identifies the bearer-secret generation. A protected SMS can send only for the exact current token version; rotation/revocation makes older versions ineligible.
- notificationVersion identifies the message-template contract. It changes only when the approved template changes and is independent of token rotation or dispatch attempts.

The send-start link CAS must include the observed dispatchRevision as well as exact link ID, SMS tokenVersion and eligible link status, then increment dispatchRevision. The SMS send-start update and link CAS commit in one session. Rotation/revocation updates the same link document with its expected token version. Exactly one operation wins the write ordering; the losing stale operation fails/retries and rechecks token version/status.

## 8. Delivery cadence and Celcom resolution

The current queue drain runs as part of `smsReminderJob()` every 15 minutes. This is a verified current cadence, not an approved onboarding delivery SLA. G5-D14 remains open until the owner sets a maximum acceptable time from lifecycle commit to first dispatch attempt.

Recommendation: retain the same SMS queue, provider adapter and `processQueuedBatch()` implementation boundary. If the approved SLA is shorter than 15 minutes, schedule a more frequent drain that calls the same dispatcher; do not add a second queue or separate provider implementation. Scheduler cadence, lock TTL, batch size and overlap behaviour must be measured and tested before production.

Celcom `unknown` remains non-retryable. B08 must be resolved using actual authenticated provider capabilities or a controlled, audited operator procedure. An operator may not simply click “resend” while the first attempt is ambiguous. If the provider later proves an attempt was not accepted, a separately authorized new attempt may be queued and audited; the previous attempt's outcome must remain recorded.

## 9. Demo/test no-send policy

The current demo seed path has a source-proven defect: it inserts “sample SMS history (not sent)” with `status: 'queued'`, while the ordinary scheduled SMS job drains queued records. Therefore demo SMS rows can reach the real Celcom provider.

G5.2 must include an explicit no-send design:

- `seedDemoClient.js` must not opt into G5 link provisioning and must never create a bearer link/outbox item.
- Demo SMS history rows must be explicitly `dispatchMode: 'SUPPRESSED'` and/or `status: 'suppressed'`; do not represent them as queued, failed or actually sent.
- The live dispatcher must claim only `status: queued` and `dispatchMode != SUPPRESSED` rows in its atomic claim predicate. A seed row uses both `status: suppressed` and `dispatchMode: SUPPRESSED`. Do not rely only on a comment or caller convention. For existing rows where `dispatchMode` is missing, `$ne: SUPPRESSED` preserves current legacy queue eligibility; the worker must not require a new field value from historical rows.
- Unit/integration tests must prove that seeded/suppressed rows are never claimed and no provider adapter is invoked.
- Test fixtures and local development must use a fake provider or disabled dispatch configuration. Never send a real link to a demo phone number by default.

A compatibility plan for existing SmsMessage rows without `dispatchMode` must preserve normal historical queue behaviour; do not silently strand existing queued jobs. A safe default/claim predicate must make explicit suppression authoritative while treating legacy missing values consistently with the current worker.

## 10. Failure matrix

| Failure | Required result |
|---|---|
| Tenant/Tenancy write fails | Entire lifecycle transaction aborts; no link/outbox/audit row remains. |
| Link insert fails | Tenant/Tenancy rollback when provisioning is REQUIRED. |
| Protected outbox insert fails | Tenant/Tenancy/link/audit rollback when provisioning is REQUIRED. |
| Encryption key absent or envelope/AAD invalid | Fail closed; no protected plaintext fallback and no G5 provisioning. |
| Mongo transaction callback retries | Same preallocated Tenant/Tenancy/link/outbox IDs, token/version and idempotency key are reused; each callback attempt creates a fresh GCM nonce/envelope under the pinned key version. Only the committed envelope survives; no external side effect occurs inside callback. |
| Commit result ambiguous | Resolve through transaction/session outcome and unique identities; do not send until commit is positively resolved. Never guess commit success. |
| Move targets same House | No-op; do not create a new Tenancy/link/outbox. |
| Move to another House with required G5 profile missing/ambiguous | Entire move rolls back. |
| `moved_out` close fails | Tenant status, Tenancy, House pointer, link and audit remain unchanged. |
| Old move/move-out request is replayed after the tenant has a newer occupancy | The expected Tenancy ID no longer matches; reject/no-op against the exact prior record. Never act on or clear the newer occupant/House pointer. |
| Old House pointer no longer matches the Tenancy being closed/transferred | Conditional House update matches zero; abort the transaction for controlled review. Never clear another tenant's pointer. |
| Move destination House has a non-null conflicting Tenant pointer but no active Tenancy row | Reject; do not overwrite or auto-repair the pointer. |
| Tenant detail has no unique ACTIVE Tenancy | Do not emit a guessed `currentTenancyId`; block move/move-out until controlled repair. |
| Rotation wins before send-start CAS | Old outbox is cancelled; worker does not call Celcom. |
| Dispatch-start wins before rotation | Redemption is invalidated by the subsequent rotation; an already-started send cannot be recalled and may deliver a now-invalid URL. Record provider outcome accurately. |
| Worker crashes before `sendStartedAt` | Lease can be reclaimed and safely requeued only if link/version is still eligible. |
| Worker crashes after `sendStartedAt` | Mark `unknown`; never blindly resend. |
| Worker response arrives after lease takeover | Stale dispatch token cannot overwrite the current record. |
| Demo seed runs | Tenant/Tenancy demo data may be seeded under its existing policy; no G5 link, no protected outbox, no live SMS dispatch. |

## 11. Required tests before G5.2 implementation is accepted

### Unit/security tests

- G5 envelope encrypt/decrypt round trip; tamper detection; wrong key; missing key; old/current key version resolution; AAD mismatch across message/client/link/version/idempotency identity.
- Inject a transient transaction failure and prove each callback retry uses a fresh nonce while reusing stable message/link IDs and idempotency key; only the committed envelope is dispatchable.
- Protected DTO/history redaction: no bearer URL, plaintext protected body, ciphertext, auth tag, key or raw destination leaks through `SmsMessage.toJSON()`, SMS history, tenant detail, logs, errors or audit metadata.
- Session-aware enqueue uses exact stable idempotency key and stores only the protected placeholder/envelope.
- Worker refuses protected rows with missing/invalid envelope and never falls back to plaintext `message`.
- The standard queue claim query explicitly excludes `deliveryMode: G5_PROTECTED`; the G5 protected claim query includes only G5_PROTECTED rows and the required non-suppressed status. Prove the two branches cannot cross-claim each other.
- Suppressed seed/test rows are never claimed.

### Real Mongo transaction/concurrency tests

- Tenant + Tenancy + link + protected outbox + critical AuditLog commit atomically.
- Inject failure after each write in create and prove all-or-nothing rollback.
- G5 `DISABLED` create/move preserves normal G3 behaviour and creates no new link/outbox; an existing old link still receives its close/transfer lifecycle transition.
- G5 `REQUIRED` without a unique operational merchant or encryption readiness aborts the whole operation.
- Move closes/opens only the selected Tenancy; the Tenant-level link persists and remains associated with that Tenant.
- Same-house move is a no-op with no duplicate link/outbox.
- `moved_out` failure rolls back Tenant, Tenancy, House, link and audit; repeated move-out cannot mutate a later tenancy.
- Stale `expectedCurrentTenancyId` move request after a subsequent move cannot move the tenant back to an old House.
- Stale `expectedTenancyId` move-out request after a new occupancy cannot close the newer Tenancy or clear its House pointer.
- A House pointer that does not match the exact Tenancy tenant causes a conflict/rollback rather than an unconditional pointer clear.
- Tenant detail returns `activeTenancies[]` with every exact ACTIVE Tenancy; move/move-out controllers require the expected ID and propagate the authenticated actor.
- Concurrent create/move operations cannot create duplicate ACTIVE tenancy/link/outbox associations.
- Rotation/revocation racing send-start CAS has one serialized winner; old token is nonredeemable after commit.
- Rotation/revocation requires the exact expected token version; replayed stale admin requests cannot rotate/revoke a later token version or create duplicate notices.
- Two workers cannot claim the same outbox row; expired pre-send lease is safely reclaimed; post-send-start expiry becomes `unknown` and cannot be resent.
- Stale worker with old lease token cannot overwrite accepted/unknown/cancelled state.
- Seed/demo SMS rows are explicitly suppressed and the provider spy records zero calls.
- Existing ordinary SMS queue tests continue to pass, including recipient idempotency, failure/unknown behaviour and concurrent claiming.

All financial/lifecycle integration tests must use a dedicated disposable `tycoon_test_*` MongoDB replica-set/sharded test database and the repository's explicit destructive-test safeguards. No test may target production or a shared developer DB. Keep output in the terminal; do not leave persistent test logs/JSON unless requested.

## 12. Owner decisions and unresolved dependencies

| Decision / blocker | G5.2 consequence |
|---|---|
| B01 Till/Store/Head Office hierarchy | Determines whether one unique operational profile can be resolved for the destination Estate/House; no link may use an ambiguous merchant. |
| B03 callback/Pull capability on actual Till | A profile is not operational until required merchant capability is confirmed; provisioning mode `REQUIRED` must fail closed otherwise. |
| B05 SMS/payer PII/raw message retention and dispute holds | No invented TTL or fixed retention duration for raw submitted SMS/payer evidence. |
| D17 protected outbound payload retention | Define when encrypted recipient/body is erased after provider acceptance and how long an `unknown` attempt may remain encrypted for controlled resolution. No TTL or fixed retention duration is assumed. |
| B08 Celcom unknown-send recovery | No automatic resend after ambiguous outcomes; define actual provider lookup or controlled operator confirmation. |
| D14 onboarding dispatch SLA | Current 15-minute drain is not an approved delivery target. Owner must choose maximum lifecycle-commit-to-first-attempt latency. |
| Lifecycle provisioning mode | Confirm whether each client/estate explicitly enables mandatory G5 link provisioning or leaves G3 tenancy operations in G5 `DISABLED` mode until merchant readiness. This must be trusted server configuration, not tenant request data. |
| Lifecycle expected-tenancy preconditions | Move and move-out requests must identify the exact current Tenancy they intend to mutate. Define the API/validator contract for `expectedCurrentTenancyId` and `expectedTenancyId`; stale IDs must fail without touching a newer occupancy. |
| Outbox key custody | Approve the dedicated G5 key source, key rotation and operator recovery process. No fallback to bank key material or unversioned global encryption. |

## 13. Implementation sequence after independent review and explicit authorization

1. The pinned-source call-site audit is recorded in §17; repeat it at the exact authorized implementation HEAD, including model writes, scripts, routes, tests and raw collection access.
2. Resolve G5-D19 and G5-D20: remove generic occupancy-status mutation paths and confirm the one-ACTIVE-Tenancy-per-Tenant invariant before proposing its partial unique index.
3. Harden tenancyService.open() with exact session-bound Tenant/House/Estate checks, a null destination pointer, an active House requirement, no existing ACTIVE Tenancy for the Tenant and matched-count enforcement. Keep low-level open() G5-disabled.
4. Fix moved_out atomicity and failure-injection tests. Refactor moveToHouse() to use a caller-owned lifecycle session without changing G3/G4 accounting invariants.
5. Add trusted DISABLED/REQUIRED provisioning and in-transaction audit. Recheck G5.1 link/idempotency index readiness.
6. Add protected SmsMessage envelope, session-aware enqueue and history/tenant DTO redaction. Prove key readiness before protected rows can be created.
7. Add fenced dispatch leases, send-start boundary, pre-send reclaimer and post-send-start unknown handling in the existing worker. Preserve standard SMS compatibility and prove seed suppression.
8. Only after B01/B03/B05/B08/D11/D14/D17 and D20 are resolved, enable operational link provisioning and controlled Celcom dispatch.

No stage includes M-PESA submission parsing, Daraja ingestion, Pull, or G3 posting; those remain later release gates.

## 14. Review outcome

**Independent review verdict: APPROVE WITH REQUIRED CHANGES.** The required documentation changes are consolidated in §16.  
**NO-GO:** all application implementation, model changes, migrations, routes, worker changes, key creation/rotation, provider calls and live SMS remain prohibited until a separate explicit owner authorization names the bounded slice.

This record is a design proposal, not proof that the actual merchant mapping, Celcom status lookup, dispatch SLA or retention policy has been approved. No application code, database, migration, credential, provider configuration or test environment was changed or exercised in this review.

## 15. External technical references

- [MongoDB Node.js Driver — Transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/) — the convenient transaction API handles retries for transient transaction and unknown commit-result errors; all operations must receive the session.
- [MongoDB Manual — Handle Transactions in Applications](https://www.mongodb.com/docs/manual/core/transactions-in-applications/) — the callback API retries the transaction for `TransientTransactionError` and retries commit for `UnknownTransactionCommitResult`.
- [MongoDB Manual — Transaction Production Considerations](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/) — transaction reads can be stale; a write such as `findOneAndUpdate()` can acquire a document write lock and force the transaction to contend correctly with concurrent writes.
- [Mongoose Connection API — `Connection#transaction()`](https://mongoosejs.com/docs/api/connection.html) — wraps the driver's transaction API and retries retriable errors; use only after reviewing compatibility with the repository's current `session.withTransaction()` pattern.

## 16. G5.2.1 — Independent review reconciliation (12 November 2026)

**Independent verdict:** APPROVE WITH REQUIRED CHANGES.  
**Resolution:** The documentation corrections below are normative. This remains a design record, not implementation authorization. No application code, model, migration, key, route, worker, provider or runtime change is authorized.

**Verified references:** The reviewed feature branch was at 6f98a2bd448e6eac4268dcfeecf0b25a7bb6267c. The pinned application source was main@204c8f9c3578f753af20727799aaa049b1545135. These source references are immutable; all source line references below are from the pinned main snapshot.

### 16.1 Finding disposition

| Finding | Reconciliation |
|---|---|
| F1 | **Confirmed BLOCKER.** tenant.service.js:193-201 has an unconditional fallback House clear. Require expected Tenancy ID and remove the fallback entirely. |
| F2 | **Confirmed BLOCKER.** tenancy.service.js:187-191 clears the old House without tenantId in the filter. Require exact tenant match and matchedCount === 1. |
| F3 | **Confirmed BLOCKER.** seedDemoClient.js:214-229 inserts “not sent” SMS as queued. Seed rows must be suppressed in both status and dispatchMode and excluded from claims. |
| F4 | **Confirmed HIGH.** tenancy.service.js:171-174, 212-214 checks active Tenancy but can overwrite a non-null destination House pointer. Any non-null pointer conflicts, even if it appears to belong to the moving tenant. No implicit repair is allowed. |
| F5 | **Confirmed HIGH.** tenancy.service.js:122-143 ignores the House update result. The exact pointer update must match one document or abort the transaction. |
| F6 | **Confirmed source defect; design detail strengthened.** sms.service.js:588-606 has no stale-processing reclaimer. The precise expiry algorithm is mandatory under §7.1. |
| F7 | **Confirmed HIGH.** sms.service.js:609-615 passes an extra idempotency argument; sms/providers/celcom/celcom.provider.js:40-48 accepts only send(mobile, message). The extra argument is ignored. Never auto-retry unknown. |
| F8 | **Confirmed HIGH design gap.** SmsMessage.js:32-36 does not currently permit suppressed/cancelled. Extend the strict enum before writing either value. |
| F9 | **Mandatory invariant made exact.** The legacy claim must exclude G5_PROTECTED; the protected claim must require G5_PROTECTED and SEND. |
| F10 | **Confirmed HIGH for G5 reuse.** tenant.service.js:172-181 returns ordinary phoneNumber/message fields. G5 serializers and history paths require explicit allowlists and redaction. |
| F11 | **Confirmed; covered by F1.** No split moved-out write path may remain. |
| F12 | **Confirmed MEDIUM.** tenant.controller.js:19-41 does not forward actor context into create/move/update lifecycle services. Propagate actor identity into the same-session lifecycle audit. |
| F13 | **Confirmed MEDIUM.** tenant.service.js:105-110 uses a House-based active tenancy lookup and does not return the ID. currentTenancyId must come from an exact tenant-scoped query plus pointer integrity checks. |
| F14 | **Confirmed MEDIUM.** utils/encryption.js:20-34 uses GCM without AAD or a versioned key envelope. Keep the dedicated G5 keyring/envelope. |
| F15 | **Confirmed MEDIUM.** utils/idempotency.js:6-21 is read-before-create and has no session parameter. Do not call it unchanged inside the lifecycle transaction. |
| F16 | **Unverified database assumption.** SmsMessage.js:39 declares unique:true, but live index presence and duplicate state were not inspected. Keep the read-only live preflight as a hard gate. |
| F17 | **Accepted residual race, owner acceptance pending.** A send past sendStartedAt may arrive after rotation/revocation with a now-invalid URL. D11 must record owner acceptance and support handling; do not delay revocation. |
| F18 | **Documentation gap.** The four revision fields are defined separately in §7.2 and the G5.1 follow-on. |
| F19 | **Owner/operations decision.** D14 must set maximum time-to-first-attempt. The existing 15-minute cadence is not an SLA. |

### 16.2 Normative tenancy lifecycle rules

1. Every move requires expectedCurrentTenancyId; every move-out requires expectedTenancyId. Missing IDs are rejected before mutation. Inside the transaction, re-read the exact ACTIVE Tenancy by ID, clientId, tenantId and status. Never substitute whichever Tenancy happens to be active for a mutable House pointer.
2. For an active Tenant, `activeTenancies[]` contains every ACTIVE Tenancy queried by clientId and tenantId. Cross-check Tenancy.houseId against Tenant.houseId and confirm the House belongs to the same client and has tenantId equal to Tenant._id. Zero/multiple rows or pointer mismatch is a lifecycle conflict. Do not return a guessed ID.
3. Releasing the old House requires the exact filter {_id: oldTenancy.houseId, clientId, tenantId: expectedTenantId} and matchedCount === 1. tenancyService.close() has the same requirement. A zero match aborts the transaction.
4. A destination House must have tenantId === null and no ACTIVE Tenancy. Any non-null pointer is a conflict, including one naming the moving Tenant. G5.2 has no automatic pointer-repair exception.
5. Move-out status, exact Tenancy close, House compare, old-link transition and critical audit share one Mongo transaction. Remove the current split write and unconditional fallback.
6. If the exact expected Tenancy is already CLOSED with closeReason MOVE_OUT, a replay is an idempotent no-op success. It must not touch the House or later occupancy. A CLOSED Tenancy with another reason is a conflict, not permission to close a newer Tenancy.
7. Authenticated controllers pass actor identity into create, move and move-out services. Tenancy actor fields and critical audit records commit in the same session.

### 16.3 Strict SMS schema and mutually exclusive claims

The pinned SmsMessage schema currently has strict type and status enums. Before creating protected rows, add type g5_onboarding_link and status values cancelled and suppressed. Never insert suppressed/cancelled before the enum supports them. A seed/test row must have status suppressed and dispatchMode SUPPRESSED. Seed code must not trigger G5 provisioning.

The following predicates are normative. The standard branch is a positive allowlist: deliveryMode and dispatchMode must each be absent (legacy row) or exactly STANDARD and SEND respectively. Explicit nulls and malformed values are excluded. The protected branch requires explicit G5_PROTECTED and SEND and fails closed if either is missing.

    const due = [
      { nextRetryAt: null },
      { nextRetryAt: { $exists: false } },
      { nextRetryAt: { $lte: now } },
    ];
    const standardClaim = {
      status: 'queued',
      $and: [
        { $or: [{ deliveryMode: { $exists: false } }, { deliveryMode: 'STANDARD' }] },
        { $or: [{ dispatchMode: { $exists: false } }, { dispatchMode: 'SEND' }] },
        { $or: due },
      ],
    };
    const protectedClaim = {
      status: 'queued',
      deliveryMode: 'G5_PROTECTED',
      dispatchMode: 'SEND',
      $or: due,
    };

The standard branch may send only ordinary phoneNumber/message rows and must never claim G5_PROTECTED. The protected branch decrypts only the authenticated envelope under a valid lease and never falls back to ordinary fields. A suppressed row is excluded by both its terminal status and dispatch mode.

### 16.4 Exact lease-expiry behavior

- Every protected claim atomically changes queued to processing and writes a fresh random dispatchLeaseToken, dispatchLeaseExpiresAt and processingStartedAt.
- **Expired before send-start:** consider only processing G5_PROTECTED/SEND rows with dispatchLeaseExpiresAt <= now, the exact current dispatchLeaseToken, and sendStartedAt null/missing. Revalidate exact linkId, tokenVersion and eligible link status. If still current, CAS the SMS row using the same lease token/expiry/no-send-start predicates, requeue it, and clear the old lease. The next claim receives a new lease token. If link/version is stale or revoked, CAS the row to cancelled. The send-start transaction must repeat the link/version fence.
- **Expired after send-start:** when sendStartedAt is non-null, CAS processing to unknown only if the exact current lease token and expired time still match. Preserve that attempt token so a late response from that same request may settle the row. Never requeue it automatically.
- Every reclaim, completion and failure update matches the current dispatchLeaseToken. A later owner-authorized attempt, if B08 permits one, must have a new attempt identity/token; an old response cannot overwrite it.
- A crash after committing sendStartedAt but before issuing the HTTP request remains unknown. This deliberately avoids duplicate sends where provider outcome is unknowable.

### 16.5 Send-start revision fence

The send-start transaction reads the link's observed dispatchRevision, then performs a write-bearing conditional link update matching exact link ID, SMS tokenVersion, eligible status and that observed revision; it increments dispatchRevision once. In the same Mongo session, update the SMS row only if status is processing, the current lease token matches, the lease is unexpired and sendStartedAt is null/missing. Require one matched link write and one matched SMS write. Commit both before invoking Celcom. Rotation/revocation writes the same link using expectedTokenVersion, so the operations serialize. If rotation/revocation wins, old-version send-start fails. If send-start wins, the request may still reach Celcom after a later rotation, but its token is already invalid for redemption.

### 16.6 Revision glossary

| Field | Meaning | Increment/change rule |
|---|---|---|
| submissionRevision | Submission-vs-rotation/revocation write fence. | Increment for each accepted submission's write-bearing link CAS. |
| dispatchRevision | Dispatch-start-vs-rotation/revocation write fence. | Increment once for successful send-start using observed revision. Not a submission counter, token version or retry count. |
| tokenVersion | Bearer-secret generation. | Increment on rotation/revocation; an SMS is eligible only for its exact current version. |
| notificationVersion | Outbound template/content contract. | Changes only when the approved template changes; independent of token rotation and worker retries. |

### 16.7 Required test additions

1. Missing expected Tenancy ID on move-out is rejected with no writes.
2. A replay for an already CLOSED MOVE_OUT Tenancy is a no-op after a later tenant occupies the House; the later Tenant and House pointer remain unchanged.
3. A CLOSED Tenancy with another close reason is not treated as an idempotent move-out.
4. Old-House pointer mismatch and close() House matchedCount === 0 both roll back all lifecycle/link/outbox/audit changes.
5. Destination House with any non-null tenantId and no ACTIVE Tenancy is rejected; include same-tenant and foreign-tenant pointer fixtures.
6. `activeTenancies[]` includes every tenant-scoped ACTIVE row and matching Tenant/House/Tenancy pointers.
7. Controller actor identity reaches Tenancy fields and same-session audit for create, move and move-out.
8. Schema validation accepts g5_onboarding_link, cancelled and suppressed. Suppressed seed SMS is never claimed and provider mock records zero calls.
9. A legacy SMS missing deliveryMode and dispatchMode remains claimable by standard branch; protected records never enter it.
10. Expired pre-send leases requeue only for the still-current link/version; stale links cancel. Expired post-send-start leases become unknown and retain their attempt token.
11. Late provider response settles only its same attempt token; stale response cannot overwrite a newer attempt.
12. Celcom unknown never requeues, despite the currently ignored third idempotency argument.
13. Live idempotencyKey index preflight confirms exact unique key pattern and duplicate state before outbox use. A Mongoose unique declaration alone is insufficient.
14. Transaction callback retry generates a fresh GCM nonce per encryption attempt and only the committed envelope can be dispatched.

### 16.8 Owner decisions and residual risk

- **D11:** owner acceptance and support handling are required for an SMS already past sendStartedAt that arrives after token invalidation with a nonredeemable URL. Revocation is never delayed.
- **D14:** owner sets maximum transaction-commit-to-first-dispatch latency; the current 15-minute drain is not a contractual SLA.
- **B08:** no resend after unknown without verified provider status or explicitly approved audited operator resolution.
- **D17:** encrypted outbound recipient/body clearing and retention/hold policy remain unapproved; no TTL or duration is invented.
- **B01/B03:** actual Till identity, destination mapping and merchant capability gate real instructions and REQUIRED provisioning.
- **B09 clarification:** B09 concerns Daraja API credential ownership/scope. It does not block non-secret Till instructions once B01/B03 are proven. No API credential, provider secret or encryption key belongs in an SMS body.

The live database index, Celcom status-lookup capability, merchant mapping, provider enablement, retention policy and owner risk acceptances were not established by this review. They remain explicit gates.

**Final G5.2 status:** APPROVE WITH REQUIRED DOCUMENTATION CHANGES; these are incorporated here. **NO-GO for implementation** until separate bounded owner authorization and relevant owner decisions/readiness gates are satisfied.

## 17. G5.2.2 — Full Tenant/Tenancy lifecycle call-site audit (12 November 2026)

### Scope and method

Pinned application source: main@204c8f9c3578f753af20727799aaa049b1545135. The recursive repository tree contained 282 entries and returned truncated=false. All 157 JavaScript files under src/, 21 JavaScript files under scripts/, and 57 JavaScript test files were fetched by blob SHA. No retrieval or decode errors occurred. A separate scan covered raw collection access and generic bulk writes. GitHub code-search responses were incomplete and were not used as evidence.

This is a complete scan of that pinned snapshot. Repeat it at the exact authorized implementation HEAD.

### 17.1 Production mutation census

| Path | Observed write | Classification |
|---|---|---|
| tenantService.create() — src/services/tenant.service.js:18-42 | Creates Tenant and calls tenancyService.open() in the same caller-owned transaction. | Supported create orchestration. G5 link/outbox/audit must join this exact transaction when REQUIRED. |
| tenancyService.open() — src/services/tenancy.service.js:70-120 | Creates ACTIVE Tenancy, writes House pointer/status, then updates Tenant pointers/status. | Sole low-level open primitive found. Under-validated; harden per §17.3. |
| tenancyService.close() — src/services/tenancy.service.js:122-155 | Closes Tenancy, clears House, sets Tenant moved_out. | Existing transaction base; require exact House matchedCount and expected tenancy identity. |
| tenancyService.moveToHouse() — src/services/tenancy.service.js:157-227 | Closes old Tenancy, clears old House, creates new ACTIVE Tenancy, updates destination House and Tenant. | Existing transaction owns its session. Refactor to caller-owned lifecycle session and enforce exact preconditions. |
| tenantService.update() — src/services/tenant.service.js:185-204 | Tenant.findOneAndUpdate() occurs before separate close; fallback can clear House. | Confirmed F1/F11. Remove split path/fallback. It also accepts status=active; see §17.2. |
| houseService.update() — src/services/house.service.js:151-277 | Generic update accepts House status and isActive. | Additional occupancy-projection writer; see §17.2. |
| scripts/seedDemoClient.js:118-163 | Creates a demo House with status occupied before Tenant/Tenancy exists; may call tenancyService.open() directly for an existing demo Tenant. | Keep G5 disabled; create seed House vacant and let transactional open mark it occupied. |

No other production Tenancy.create() or Tenancy occupancy-status writer was found under src/ and scripts/. Other production Tenancy.updateOne() calls in accountingPosting.service.js:289-293, ledger.service.js:130-134, and reconciliation.service.js:214-223,445-449 increment only ledgerRev inside financial transactions. They are accounting serialization fences, not occupancy mutations; preserve them. No raw production collection mutation or generic bulk-write occupancy path was found. Other Tenant/Tenancy imports in deposit, billing, HouseType, reporting and integrity services were read-only for occupancy.

### 17.2 Two additional generic API mutation paths

**F20 — Generic House PATCH rewrites occupancy status (HIGH, confirmed).**

- house.routes.js:42-49 exposes authenticated owner/admin PATCH /houses/:id.
- validators.js:78-90 accepts status occupied/vacant and isActive.
- house.service.js:175-180,266-270 persists those fields without checking House.tenantId or an ACTIVE Tenancy.
- House.js:29-33 stores tenantId and status separately.
- payment.service.js:88-100 uses house.status === occupied to decide whether to generate House charges before the ACTIVE Tenancy lookup.

An admin can mark an occupied House vacant while its Tenancy and pointer remain active, or mark a vacant House occupied without a Tenant/Tenancy. This is not cosmetic: House.status affects manual-payment charge generation. The same PATCH can deactivate a House that still has an active occupant.

**Required correction:** remove status from generic House PATCH and the houseService.update() allowlist. Only the tenancy lifecycle transaction may set House occupancy status. Reject House deactivation while tenantId is non-null or an ACTIVE Tenancy exists. Tenant detail/currentTenancyId must treat disagreement among ACTIVE Tenancy, Tenant pointer, House pointer and House.status=occupied as a lifecycle conflict.

**F21 — Generic Tenant PATCH reactivates without a Tenancy (HIGH, confirmed).**

- validators.js:99-107 accepts status active or moved_out.
- tenant.controller.js:27-34 passes generic PATCH to tenantService.update().
- tenant.service.js:185-204 writes the status directly. Only moved_out enters the existing close path; active does not open a Tenancy or restore House pointers.

**Required correction:** generic Tenant PATCH must not set status=active. Any future reactivation must be a separate approved lifecycle operation that creates a new immutable Tenancy and updates House/Tenant pointers atomically. Move-out still requires expectedTenancyId and the unified close transaction.

### 17.3 Harden tenancyService.open()

The pinned open() implementation at tenancy.service.js:70-109 rejects a House pointer only when it belongs to a different Tenant. A stale pointer to the same Tenant is accepted if no ACTIVE Tenancy exists. It does not require House.isActive, does not prove the Tenant exists in the same client/session or belongs to the target House/Estate, ignores Tenant.updateOne().matchedCount, and does not verify a supplied estateId against House.estateId.

Mandatory preconditions inside the caller's Mongo session:

1. Re-read House by _id + clientId and require isActive=true.
2. Derive estateId from House; reject a supplied estateId that differs.
3. Require House.tenantId=null and no ACTIVE Tenancy for the House. Any non-null pointer is a conflict, including the same Tenant. Do not silently repair.
4. Re-read exact Tenant by _id + clientId and verify its ownership/state is consistent with the target House/Estate. A Tenant created earlier in tenantService.create() is visible in the same session.
5. Require no other ACTIVE Tenancy for the target House; other ACTIVE Tenancies for the same Tenant in different Houses within the same Estate are permitted.
6. Create Tenancy, update House and Tenant in the same session; require Tenant.updateOne().matchedCount===1 or abort.
7. Keep low-level open() free of G5 provisioning. Only the top-level approved lifecycle orchestrator creates link/outbox.

### 17.4 Owner-approved one-to-many Tenant/Tenancy cardinality

The owner confirmed that one Tenant profile may have multiple simultaneous ACTIVE Tenancies in different Houses within the same Estate. The proposed `{ clientId, tenantId }` unique partial ACTIVE index is withdrawn and must not be created. Keep the existing unique partial ACTIVE-Tenancy-per-House barrier. `tenancyService.open()` must reject an already occupied target House, but must not reject another active Tenancy for the same Tenant in a different House in the same Estate.

Concurrent opens for one Tenant across different vacant Houses may both commit; same-House concurrent opens must serialize to one winner.

### 17.5 Seed and test findings

- seedDemoClient.js creates a House with status=occupied before tenantService.create()/tenancyService.open() commits matching Tenant/Tenancy. Create it vacant; the transactional open sets it occupied.
- The only direct low-level open() caller outside tenantService.create() in the scanned scripts is seedDemoClient.js. Do not hook G5 provisioning into open().
- Direct Tenancy creation/status edits in g3.accounting.test.js and reconciliation.test.js are historical fixture setup, not production callers. Lifecycle tests must use production services.
- updateSchemas.test.js:31-59 checks that tenantId/houseId are stripped and tests a normal move, but it does not test House.status, House deactivation, Tenant reactivation, stale expected IDs, pointer mismatches or open() guards.

### 17.6 Required additional tests

1. Generic House PATCH and direct houseService.update() cannot mutate occupancy status.
2. Deactivation of a House with a non-null tenant pointer or ACTIVE Tenancy fails without mutation.
3. Generic Tenant PATCH cannot reactivate a moved-out Tenant without a new Tenancy.
4. open() rejects inactive Houses, any non-null House pointer, mismatched Estate, missing/foreign Tenant, Tenant/House ownership mismatch and another ACTIVE Tenancy for that Tenant.
5. open() aborts when Tenant update matchedCount is zero; no Tenancy or House pointer commits.
6. Two concurrent open() calls for one Tenant on different vacant Houses in the same Estate may both succeed; concurrent opens for the same House produce exactly one winner through the existing per-House unique index.
7. Seed Houses start vacant and become occupied only after the Tenant/Tenancy transaction commits.
8. `activeTenancies[]` returns every ACTIVE row only after each Tenancy/House pointer and House status are cross-checked; no singular currentTenancyId is inferred.
9. Existing ledgerRev write-fence tests remain green; those writes are financial serialization, not occupancy mutation.

### 17.7 Implementation gate

Before G5.2 application work, rerun this scan at the authorized implementation HEAD; resolve D19/D20; preserve the existing per-House uniqueness barrier; do not add a per-Tenant unique index; harden open(); and remove generic occupancy mutation paths. No application code, database, migration, index, provider, key or test environment was changed or exercised by this audit. G5.2 remains NO-GO for implementation pending explicit bounded owner authorization.


## 21. G5.2.3 — Tenant-level link and multi-unit lifecycle correction

This section supersedes prior G5.2 wording that binds the link and protected SMS to one Tenancy. The link is one per Tenant identity within the client/Estate. One-unit and multi-unit experiences differ only in the number of eligible Tenancies shown/settled.

- Create the Tenant-level link once when G5 provisioning is first required. A later House addition retains the same link. A unit-specific SMS notification may be sent through the existing SMS system and may refer to that same Tenant-level link; no sender ID/provider redesign is involved.
- Move/move-out requests require `expectedTenancyId` for the exact unit being changed. Closing or moving one Tenancy cannot close another active Tenancy owned by that Tenant.
- The Tenant DTO exposes `activeTenancies[]`, not `currentTenancyId`. `Tenant.houseId` is not an authority for occupancy or payment attribution. `Tenant.status` remains active while at least one ACTIVE Tenancy exists; per-unit dates and status live on Tenancy records. Tenant-level compatibility fields are addressed in D21 without blocking G5 link identity.
- Keep one canonical MpesaTransaction claim per verified receipt and Tenant. Combined receipt settlement invokes G3 to create per-Tenancy Payments/allocations and any Tenant-account credit movement atomically. G5 does not perform accounting writes itself.
- A surplus becomes Tenant-account carry-forward credit in G3, applied to future combined rent due within the same client/Estate. The current Tenancy-only credit functions are insufficient; this is an explicit G3 extension, not a new M-PESA wallet.
- Each Client's rent effective-date/proration policy is applied by existing G3 billing configuration. G5 consumes the resulting RentCharges and must not invent an effective date.
- This correction remains documentation-only. No G3 source code, model, index, migration, route, SMS configuration, key, worker or provider change is authorized.


## 22. G5.2.4 supersession note — link and occupancy rules

Sections earlier in this decision record that describe one link per Tenancy, a link-bound `tenancyId`, a new link on every move, a singular `currentTenancyId`, or one ACTIVE Tenancy per Tenant are superseded by §21.

The authoritative rules are: one Tenant-level link per `{ clientId, estateId, tenantId }`; multiple ACTIVE Tenancies for one Tenant are valid in different Houses within the same Estate; per-House ACTIVE uniqueness remains; move/close names one exact `expectedTenancyId`; the Tenant DTO returns `activeTenancies[]`; combined M-PESA receipts are claimed once and settled through G3 per-Tenancy postings plus any Tenant-account carry-forward credit.

G5 uses the existing SMS provider and sender configuration. Client rent effective-date and proration policy is owned by Client configuration/G3 billing. G5 attributes verified receipts to the obligations G3 generates.
