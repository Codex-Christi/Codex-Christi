# Shop Alpha Order Flow Transfer Prompt

Use this prompt to continue the pre-alpha implementation in a new Codex task.

---

We are continuing Codex Christi public-alpha shop order-flow work.

First read:

1. `Future Implementation Guides/SHOP_ALPHA_ORDER_FLOW_RELEASE_GUIDE.md`
2. `Future Implementation Guides/PAYPAL_TX_LEDGER_GUIDE.md`
3. `Future Implementation Guides/PAYPAL_WEBHOOK_REGISTRATION_AND_RECOVERY_GUIDE.md`
4. `Future Implementation Guides/MERCHIZE_FULFILLMENT_OPS_GUIDE.md`
5. `Future Implementation Guides/ADMIN_RECOVERY_TOOLING_GUIDE.md`
6. `Future Implementation Guides/SHOP_CHECKOUT_RECOVERY_IMPLEMENTATION_GUIDE.md`

The release guide is canonical for priority and resolved product decisions. The other guides remain
domain references. If an older guide says a different item is "next" or contains an unresolved
decision already resolved by the release guide, follow the release guide.

Current checkpoint: 2026-08-06. The P0.2 snapshot/payment foundation and local current-sellability
correction are complete. Merchize `all-variants` is identity only; availability now requires exact
current Product-line/options proof or completed-current-catalog SKU proof, with storefront and
supplier SKU namespaces kept separate. Local SQLite received the additive compatibility update, but
the PayPal ledger migration and deployed sandbox/E2E verification remain pending.

## Product target

Deliver a public alpha. It is not invite-only. Every completed ordinary Codex Christi account signup
is implicitly treated as joining the alpha waitlist. This is a rollout assumption, not a separate
persisted participation state. Small informational notices on the signup page and shop homepage make
alpha status visible while preserving the core registration → OTP → login structure. Incremental
auth enhancements may be scoped separately when they preserve that contract and support the
customer-order path.

The alpha must support a smooth real-customer flow:

- trusted server pricing and order snapshot;
- PayPal capture and reconciliation;
- receipt;
- Django payment save and accepted fulfillment handoff;
- Merchize registration, lookup, readiness, push, and verification;
- secure order confirmation across devices;
- customer/admin notifications;
- state-aware progress/tracking/delivery reconciliation;
- safe admin recovery without payment replay.

## Non-negotiable contracts

- `runPaidFulfillmentProcessing(orderToken)` is the canonical parent orchestrator.
- Never replay PayPal authorization/capture, receipt generation, Django payment save, or an accepted
  Django handoff from fulfillment-only retry.
- A Django `200`/`201`, `success = true`, `data.processing_status = "completed"` response with
  `error_message = "Order created but details not available"` is accepted.
- `orderToken` is the local support/customer reference.
- `djangoPaymentSaveCustomId` is the Django `/orders/process/{custom_id}` path value.
- `merchizeExternalOrderNumber` is the `ORD-...` external number.
- `merchizeOrderId` is `resp.data._id` from external-number lookup.
- Never use Django wrapped `response_data.data._id` as the actionable Merchize id.
- Keep Merchize Ops separate from PayPal payment retry.
- Confirmation status reads must stay side-effect free.
- Use `X-API-KEY` only from the server for Merchize routes proven to support it.
- Do not expose or log secrets, raw PII, provider payloads, customer addresses, or Postman fixtures.

## Resolved alpha decisions

- Preserve the core Django-backed signup, OTP verification, and login flow. Independently justified
  auth improvements or migrations are allowed, but do not couple them to alpha participation or
  mistake them for the current release priority.
- Treat every successful ordinary signup as implicit alpha-waitlist participation. Do not create an
  enrollment table, participation API, acknowledgement record, duplicate reconciliation, or
  email/user linking flow.
- Keep alpha disclosure non-blocking: one small notice on signup and one on the shop homepage. Do
  not add a checkbox, modal, versioned dismissal, or waitlist query-state pipeline.
- No arbitrary small SKU allowlist. `all-variants` membership is storefront identity only. Any
  offered variant can sell only after exact current product-line/catalog reconciliation, price, and
  shipping resolve from trusted server data. Storefront and supplier SKU namespaces remain
  separate. This is an order-integrity check, not a new destination or tax policy.
- Preserve the existing multi-currency checkout and PayPal behavior. The canonical snapshot records
  the exact server-resolved currency and amounts; the alpha is not restricted to USD.
- The current PayPal setup does not provide tax-charging capability. Do not calculate, add, collect,
  or pass a tax amount or tax line to PayPal during the alpha.
- US address `valid` plus exact read-back may auto-push.
- Non-US `other`/`others` plus exact read-back may auto-push, labeled not provider-validated.
- Explicit US invalid or address mismatch pauses before push and notifies customer and admin.
- Customer correction is Next.js-owned. Keep Django at its current intent/payment-save/initial
  fulfillment handoff boundary.
- Require an inline final address/size/variant/quantity acknowledgement before PayPal.
- Codex Christi owns customer emails: payment received, address action, preparing, tracking,
  shipped, and delivered.
- Guest cross-device confirmation uses an emailed, purpose-bound, long-lived viewing capability with
  OTP reissue. Authenticated access uses `userId` ownership.
- Keep capture-route `after(...)` continuation as the explicitly enabled fast trigger; the scanner is
  the durable fallback. PayPal webhooks remain a payment safety net.
- Merchize webhooks are P1. Synchronous API reads plus scheduled polling must make P0 complete.
- Keep the storefront's current destination behavior during canonical-snapshot work. Do not add,
  remove, or redefine destination coverage without separate product direction.
- Refunds, disputes, automated cancellation, arbitrary product/artwork mutations, and full provider
  dashboard parity are out of scope.

## Current state and next action

- P0.1 remains intentionally lightweight: ordinary signup/OTP/login is preserved, every completed
  signup is treated as joining the alpha waitlist, and no participation subsystem exists.
- P0.2 now resolves trusted product/variant/SKU/price/currency/shipping data at ledger intent
  creation, seals it as a versioned/hash-checked snapshot, and builds PayPal only from that
  snapshot.
- P0.2 extends the existing `PaypalIntent` ledger; it adds no standalone order database/table and no
  alpha-participation persistence.
- Trusted Merchize publication state still rejects explicitly inactive/hidden/deleted/private/
  taken-down/draft/retired/unapproved selections, but `all-variants` membership does not prove
  sellability. With a `Product` option, require one exact current product-line name plus complete
  option-map match and use the resolved supplier SKU. Without a `Product` option, require exact
  current SKU membership from a completed supplier-catalog generation. Missing, ambiguous, partial,
  stale, or unverified evidence fails closed; storefront and supplier SKU namespaces stay separate.
  Compatibility reads time out after 15 seconds. The same verdict fails closed at public variant
  display, add-to-cart, stale-cart hydration/revalidation, quantity increase, checkout entry, direct
  checkout, and PayPal intent creation. A stale cart row remains visible and removable but cannot be
  increased or purchased. Base-product, `all-variants`, and current-price trust reads are strict
  `no-store` calls; storefront snapshots remain display-only fallback. Exact product-line supplier
  product/variant IDs and SKU must equal the completed catalog row. Strict catalog proof requires
  both parent and variant generation IDs to equal `SyncState.lastCompletedRunId`, with bounded writes
  and generation finalization fenced inside the active lease transaction.
- Selection input remains bounded to 25 rows, 128 characters per ID, 25 units per merged line, and
  100 total units; duplicate selectors are merged/rechecked and provider work remains concurrency-
  bounded. The correction must preserve those request-amplification limits.
- Admin/scheduled published-variant audits globally trim, dedupe, and sort discovered product IDs,
  then await deterministic chunks of at most 100 sequentially. This audits sets above 100 without
  exceeding the underlying four-product-worker bound and aggregates all chunk counts, results, and
  product errors.
- The PayPal ledger has the additive `canonicalOrderSnapshot`,
  `canonicalOrderSnapshotVersion`, and `canonicalOrderSnapshotHash` fields plus migration
  `20260806000000_add_canonical_order_snapshot`. Only an all-null triple is legacy; partial or
  corrupt metadata fails closed.
- Authorization, capture, webhook/reconciliation recovery, scanners, the fulfillment runner,
  mutating admin recovery, receipts, Django payment-save amount, fulfillment items, Merchize Ops
  summaries, and recovery displays now consume or reconcile the canonical snapshot. The shared
  authorization-plus-capture chain prevents a matching capture from hiding an authorization
  mismatch. Exact amount/currency mismatch prevents post-payment side effects.
- Authorization-route, capture-route, webhook, and payment-reconciliation evidence updates use
  fresh-row optimistic compare-and-swap. Authorization-webhook races are resynchronized; durable
  signed authorization/capture mismatches survive later contradictory evidence; and stale pending,
  missing-reference, or timeout results cannot replace completed evidence or move post-capture
  state backward.
- Recovery displays distinguish expected order value from money actually paid: paid labels use the
  completed PayPal capture, and a difference from the canonical total is flagged for review.
- P0.2 preserves existing currencies and destination behavior. The snapshot and PayPal request
  contain merchandise plus shipping only; there is no tax amount or tax line.
- The correction is locally verified: the additive local SQLite `db push` completed; a complete
  current-catalog generation contains 905 products and 19,885 variants; the pre-final live baseline
  audit returned 141 total, 138 available, 3 unavailable, and 0 unverified across 13 products; and
  the final dual-source catalog gate has six focused regressions. The full local suite passed 195/195
  tests together with TypeScript, targeted ESLint, the production webpack build, and diff checks. A
  repeat live audit under the final gate and deployed sandbox/E2E remain pending. The repair run sent
  no notification email.
- Only confirmed current drift/unavailability creates or updates a per-variant catalog-health
  incident. Provider timeouts/outages and incomplete or otherwise unverified evidence remain one
  aggregate operational condition and do not fan out into incidents. Confirmed incidents accumulate
  in the detailed Storefront Data Health admin queue. P0.2 does not add a catalog email/outbox path;
  any later outbound escalation belongs with the explicitly scoped notification work.
- The main `/admin/shop/storefront-data-health` page keeps only compact incident counts. Detailed
  repair evidence is isolated at
  `/admin/shop/storefront-data-health/variant-publication-issues` in responsive, collapsed-per-issue
  rows with server-side pagination, so every open incident remains reachable while catalog statistics
  and SKU lookup stay easy to reach. A storage failure is shown as unavailable counts, never as zero.
- The apparent development migration-name divergence was a lost legitimate migration file.
  Development has both the original `20260622190000_add_paypal_ledger_transaction_webhook_bindings`
  migration and the later `20260622190331_add_paypal_ledger_transaction_webhook_bindings` index
  rename recorded successfully. The exact rename SQL is restored in the repository with checksum
  `2356add3eeef5a0e2c45d179244f99c262c4658590beb55116243f0c7787df3e`; do not rewrite database
  history or use `migrate resolve`.
- The restored 13-migration chain passes on disposable PostgreSQL. Read-only status shows only the
  canonical-snapshot migration pending in development and the restored index rename as production's
  first pending migration. The immediate action is explicitly approved development migration
  deployment followed by deployed PayPal sandbox/E2E. P0.3 begins afterward as a read-only trace.

Remaining release gaps after that checkpoint include:

- missing `MERCHIZE_FULFILLMENT_PUSH_ENABLED` currently enables push instead of failing closed;
- raw `orderToken` possession can read confirmation status;
- only the preparing customer email is implemented;
- most footer policy links are placeholders;
- cron heartbeat/global pending-outbox dispatch are incomplete;
- lifecycle provider reads are too request-heavy.

## Required first implementation order

1. With explicit database approval, run `prisma migrate deploy` against development. The index
   rename is already recorded there, so only the canonical-snapshot migration should apply. Run the
   deployed PayPal sandbox/E2E P0.2 acceptance cases afterward.
2. After development evidence passes, deploy production through the normal reviewed rollout.
   Production must apply the restored index rename first and the canonical-snapshot migration
   second. Keep release gates unchecked until their deployed evidence exists.
3. Perform P0.3 as documentation and read-only code/data tracing only. Record existing destination
   behavior and confirm P0.2 did not change coverage, currencies, or customer copy. Do not modify
   destination eligibility, add geographic blocks, introduce a policy table, or add tax behavior.
4. Persist final address and made-to-order selection acknowledgement.
5. Add authenticated/guest confirmation authorization and customer-safe lifecycle projection.
6. Centralize readiness disposition, US/non-US address policy, and address correction/read-back.
7. Make provider push configuration explicit and fail-closed.
8. Implement all six customer milestone outbox events and complete admin escalation.
9. Add state-aware/batched lifecycle polling, global outbox dispatch, and scheduler heartbeat.
10. Replace policy placeholders and execute the staged E2E acceptance program.

Do not jump to Merchize webhook implementation until the P0 gates in the release guide pass.

## Scope guard for alpha participation

- Do not interpret "waitlist" as a new account-domain or Next.js-owned data model.
- A "Join waitlist" marketing CTA links to ordinary signup; it does not create a separate query-state
  or registration branch.
- Do not propagate `waitlist`, source, notice-version, or acknowledgement state through signup, OTP,
  or login.
- Do not make alpha disclosure a condition of account creation or authentication.
- Do not add participation persistence, APIs, user linking, deduplication, announcement preferences,
  or associated migrations.
- Keep any future auth hardening or account migration as its own scoped change with its own
  acceptance criteria; it must preserve the core signup → OTP → login contract.
- Keep engineering effort on the minimum viable customer order path: signup, trusted checkout,
  payment, confirmation, production handoff, lifecycle communication, delivery, and safe recovery.

## Scope guard for the canonical order snapshot

- P0.2 changes which data is authoritative; it does not redesign checkout policy.
- Preserve all currently supported checkout and PayPal currencies. Do not impose an alpha-wide
  USD-only rule.
- Preserve current destination coverage during P0.2.
- The current PayPal setup cannot charge tax. Do not calculate, add, collect, or pass a tax amount
  or tax line to PayPal. The canonical monetary snapshot, PayPal purchase unit, and receipt use
  merchandise plus shipping only.
- Rejecting a missing SKU or unsafe fabricated shipping fallback is an order-integrity check, not a
  new destination allowlist.
- Treat storefront `all-variants` rows as identity only. For variants with a `Product` option,
  require one exact current product-line name plus complete option-map match, then require its
  supplier product ID, supplier variant ID, and SKU to match the latest completed catalog generation.
  For variants without one, require exact current SKU membership from that completed generation.
- Keep storefront and supplier IDs/SKUs in separate namespaces. Never substitute, assume equality,
  accept a fuzzy/nearest option, or treat partial provider data as positive sellability evidence.
- Bound compatibility reads to 15 seconds and apply the same fail-closed verdict at public variant
  display, add-to-cart, cart hydration/revalidation, quantity increase, checkout entry, direct
  checkout, and PayPal intent creation. Keep a stale row visible/removable. Record a per-variant
  incident only for confirmed drift; keep provider outages/timeouts and incomplete/unverified reads
  aggregate. Use the persistent Storefront Data Health queue for admin action; do not add catalog
  email or PayPal-outbox coupling in P0.2.
- Pre-P0.2 compatibility applies only when canonical snapshot, version, and hash are all null.
  Partial, invalid, or mismatched metadata is corruption and must not fall back to cart data.
- Treat any future destination-policy change as separate work requiring explicit product direction,
  acceptance criteria, and rollout planning. Tax support is outside this guide and must not be
  implemented without explicit new direction after the required PayPal capability exists.

## How to begin

1. Run `git status --short` and inspect recent commits.
2. Re-scan the current implementations before editing because other agents may have changed files.
3. Compare the code against the release guide's "Current Codebase Checkpoint."
4. Treat the current-sellability code and local automated verification as complete. Repeat the live
   compatibility audit under the final dual-source gate, then confirm explicit approval and deploy
   the pending canonical-snapshot migration to development. Run deployed PayPal sandbox/E2E before
   beginning the P0.3 read-only trace.
5. Before editing, state the exact files and behavior being changed.
6. Use existing patterns, preserve unrelated dirty changes, add risk-proportionate tests, and verify
   migrations against both dev and production branches when schema changes are involved.

Do not broaden scope into refunds, disputes, product changes, cancellation automation, or full
Merchize dashboard parity without asking.
