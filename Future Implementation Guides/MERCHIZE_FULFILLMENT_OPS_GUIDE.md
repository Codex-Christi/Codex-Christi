# Merchize Fulfillment Ops Guide

Last updated: 2026-08-06

This guide defines the Merchize side of Codex Christi paid order fulfillment processing. It is intentionally separate from the PayPal transaction ledger guide and the admin recovery tooling guide, but it is not merely a post-push sync guide.

The short version:

- The PayPal TX ledger answers: "Was the paid checkout safely captured, receipted, and saved?"
- Paid order fulfillment processing answers: "Did the paid order move through Django, Merchize catalog import, push-to-fulfillment, and operational checks without unsafe gaps?"
- The Merchize Fulfillment Ops layer answers: "What is the provider state, what needs attention, and what can admin safely repair or reconcile?"

This guide is intentionally Merchize-specific. Other POD suppliers can get their own ops guide later after this flow is stable.

Related source docs:

- `SHOP_ALPHA_ORDER_FLOW_RELEASE_GUIDE.md`
- `PAYPAL_TX_LEDGER_GUIDE.md`
- `ADMIN_RECOVERY_TOOLING_GUIDE.md`
- `PAYPAL_WEBHOOK_REGISTRATION_AND_RECOVERY_GUIDE.md`

Release sequencing note:

- `SHOP_ALPHA_ORDER_FLOW_RELEASE_GUIDE.md` is now canonical for public-alpha priority, resolved
  product decisions, customer milestones, and release gates.
- This guide remains authoritative for detailed Merchize identifiers, endpoint contracts, schemas,
  readiness rules, and recovery behavior.
- Older "imminent", phase-order, and open-decision text below is domain backlog context and must not
  override the canonical release plan.

P0.2 downstream boundary:

- New orders reach this domain with canonical product/variant/supplier IDs, SKUs, options,
  quantities, prices, currency, and destination from the existing PayPal `PaypalIntent` ledger.
  Registration, item comparisons, and address-correction targeting use those values.
- `cartSnapshot` is compatible only for a pre-P0.2 row whose canonical snapshot/version/hash triple
  is entirely null. Invalid, partial, corrupt, or payment-mismatched canonical rows cannot reach
  Merchize registration, sync, correction, or production mutation.
- This does not create a Merchize-owned or standalone order store and does not change destination,
  currency, or tax policy. Canonical/PayPal/receipt totals remain merchandise plus shipping only.

---

## 2026-07-24 Implemented: Shop Ops Data Target And Recovery Scope Hardening

Runtime PayPal TX Ledger and Merchize Fulfillment Ops access now shares one canonical target:

```bash
SHOP_OPS_DATA_TARGET=dev # or prod
```

Required pooled URLs for the selected runtime target:

```bash
# Development target
PAYPAL_TX_LEDGER_NEON_POOLED_DB_DEV_STRING=...
MERCHIZE_FULFILLMENT_OPS_NEON_POOLED_DB_DEV_STRING=...

# Production target
PAYPAL_TX_LEDGER_NEON_POOLED_DB_STRING=...
MERCHIZE_FULFILLMENT_OPS_NEON_POOLED_DB_STRING=...
```

The legacy `PAYPAL_TX_LEDGER_NEON_BRANCH` and
`MERCHIZE_FULFILLMENT_OPS_NEON_BRANCH` selectors remain supported as an aligned runtime fallback
while deployments migrate, but when `SHOP_OPS_DATA_TARGET` is present it is authoritative. Keep the
legacy selectors for the existing Prisma CLI generation/migration scripts; runtime no longer needs
them to choose separate branches.

Runtime safety contract:

- A target is usable only when both selected pooled URLs exist. Cross-ledger actions fail before
  mutation when the target is absent, invalid, or only one database URL is configured.
- Paid-order recovery pages visibly identify `Development data` or `Production data`.
- A non-production process targeting production is read-capable but mutation-locked by default.
- An intentional localhost production recovery additionally requires:

  ```bash
  SHOP_OPS_DATA_TARGET=prod
  SHOP_OPS_ALLOW_LOCAL_PRODUCTION_MUTATIONS=true
  ```

- The dev server must be restarted after changing target configuration. Use a separate port/process
  for an intentional production support session.
- Localhost production retry, manual release, mark-valid, and address correction require
  master-admin password confirmation plus a recorded reason.
- Localhost production scanner execution, provider refresh, and receipt regeneration remain blocked
  because those controls do not have a dedicated production step-up flow. Use the production admin
  deployment for them.
- Automated capture, webhook, and scanner runners cannot mutate production from a local runtime by
  merely enabling the env switch; the processing call must carry explicit master-confirmed
  authorization.

Retry scope is now explicit:

- `Resume post-payment processing` may continue missing receipt generation, Django payment save,
  Django fulfillment handoff, and subsequent provider stages from durable checkpoints.
- `Retry Merchize fulfillment` is fulfillment-only. It refuses to run unless completed capture,
  persisted receipt, `djangoPaymentSaveCustomId`, an accepted Django fulfillment response, and
  `merchizeExternalOrderNumber` are already present.
- Fulfillment-only retry never replays capture, receipt generation, Django payment save, or the
  accepted Django handoff.
- Retry audit entries record data target, target source, runtime environment, execution scope,
  resulting status, error code, and failed stage.
- Unexpected runner errors now persist and return stage-specific codes such as
  `DJANGO_PAYMENT_SAVE_FAILED`, `PAYMENT_RECEIPT_GENERATION_FAILED`, or
  `MERCHIZE_ORDER_REGISTRATION_FAILED` instead of collapsing every failure to
  `POST_PROCESSING_FAILED`.

# Merchize Domain Backlog: Address Intervention And Lifecycle Hardening

Status: **PARTIALLY IMPLEMENTED, REMAINING WORK SEQUENCED BY THE ALPHA RELEASE GUIDE**.
The detailed requirements remain useful, but this is no longer the cross-domain canonical "what is
next" queue. Start with `SHOP_ALPHA_ORDER_FLOW_RELEASE_GUIDE.md` and use this section when its active
P0 slice reaches the Merchize domain.

The next phase must make automatic production release safe for customer-actionable address problems,
make scanner and email delivery health observable, and finish the minimum useful post-push lifecycle.
It must not broaden into product replacement, refunds, disputes, cancellation automation, or full
Merchize dashboard parity.

## Current runtime truth at this checkpoint

- Capture-route continuation and the PayPal recovery scanner both call
  `runPaidFulfillmentProcessing(orderToken)`. The same pre-push readiness checks therefore run
  regardless of which automatic trigger owns the attempt.
- The PayPal-ledger processing lease prevents overlapping capture, webhook, scanner, and admin
  attempts from owning the same paid-order side effects at the same time.
- `MERCHIZE_ADDRESS_INVALID` and `MERCHIZE_PROVIDER_ADDRESS_MISMATCH` are non-retryable production
  blockers. The runner does not call `POST /order/external/orders/push`; it moves the PayPal row to
  `fulfillment_attention_required`, creates a durable admin outbox row, and attempts the configured
  admin email.
- `MERCHIZE_ADDRESS_VALIDATION_PENDING`, unknown validation evidence, provider indexing lag, and
  other retryable readiness states leave the PayPal row at `payment_saved` so the scheduled recovery
  scanner can retry without replaying capture, receipt upload, Django payment save, or accepted
  Django catalog import.
- Customer email currently exists only for verified production release. There is no customer
  address-review email or secure customer correction flow.
- The current checkout policy notice is passive and rendered after the PayPal component. It is not
  an address-confirmation gate and its acceptance is not persisted.
- The current `customerEmail` is the immutable checkout/payment recipient identity. The admin
  address-correction flow preserves the existing Merchize buyer email and does not expose an email
  correction.
- The authenticated cron route runs payment recovery and post-push Merchize lifecycle reconciliation,
  but it does not persist a scheduler heartbeat. Repository code alone therefore cannot prove that
  the external scheduler is currently invoking it successfully.
- Existing rows already stopped as `fulfillment_attention_required` with
  `MERCHIZE_PUSH_DISABLED_BY_CONFIG` must not auto-release merely because
  `MERCHIZE_FULFILLMENT_PUSH_ENABLED` later changes to `true`. They require an audited admin
  continuation.

## Provider address-validation boundary

Merchize's [Verify US Shipping Address](https://merchize.com/helpdesk/verify-us-shipping-address/)
guide says its automated verifier is for US addresses. The implementation must preserve this
distinction:

- `valid` means Merchize validated a US address.
- An explicit invalid value such as `invalid`, `street_undefined`, `zipcode_undefined`, `inactive`,
  `missing_secondary`, `vacant`, `spelling`, or `fullname_undefined` is customer/admin actionable.
- `other` or `others` means the destination is outside the provider's US validation scope. It may
  proceed, but the customer and admin UI must never describe it as provider-validated.
- Exact buyer-details read-back applies to every country. It proves only that Merchize stored the
  same address as the effective ledger address; it does not prove deliverability.

## Imminent intervention policy

| Evidence | Automatic action | Admin communication | Customer communication | Resume rule |
| --- | --- | --- | --- | --- |
| US address `valid` and exact read-back matched | Continue remaining gates | None unless another blocker exists | None | Automatic |
| Non-US `other` / `others` and exact read-back matched | Continue remaining gates | None unless another blocker exists | None | Automatic, while labeled not provider-validated |
| Address validation `pending` | Pause before push and retry after bounded delay | Alert only after grace/attempt threshold | None while transient | Automatic after `valid`; otherwise escalate |
| Address validation unknown or provider request unavailable | Pause before push and retry | Alert after bounded repeated failure | Generic delay notice only if the customer wait becomes material | Automatic only after explicit safe evidence |
| Explicit invalid US address | Pause before push | Immediate durable warning and email | Immediate safe correction/confirmation request | See corrected-address and buyer-confirmed rules below |
| Buyer-details read-back mismatch | Pause before push | Immediate durable warning and email | Immediate correction request when customer action can help | Resume only after provider read-back matches |
| Product, catalog mapping, required artwork, provider attention, or closed-order blocker | Pause before push | Immediate durable warning and email | Do not expose provider jargon; send a generic delay update only after a customer-impact threshold | Admin resolution |
| Seven-day manual-release gate | Pause before push | Immediate admin action item | None | Master-admin release; all other gates still apply |
| Push disabled by configuration | Pause before push | Immediate admin action item | None | Explicit master-admin continuation |
| Push request or verification failure | Do not replay payment/import; verify or retry only the provider stage | Immediate failure alert | Generic delay update only when unresolved beyond threshold | Existing idempotent provider recovery |
| Push verified | Mark completed and start lifecycle reconciliation | Existing optional success email | Existing "preparing your order" email | No replay |

## Implementation sequence

### 1. Centralize blocker disposition and close runner notification gaps

Create one server-only policy that maps a readiness/provider error to:

- `retryable_pending`;
- `customer_action_required`;
- `admin_action_required`;
- `terminal_provider_failure`; or
- `verified_success`.

The runner, recovery scanner, admin projection, and notification enqueue code must consume the same
classification. Do not independently reinterpret error codes in each surface.

Required fixes:

- Honor `MerchizeProductionReadinessCheckResult.retryable` when `ok = false`. A non-retryable
  readiness infrastructure/configuration failure must not loop forever as `payment_saved`.
- Enqueue an admin alert for unexpected `POST_PROCESSING_FAILED` errors after the durable ledger
  transition. The current generic catch stores the error but does not guarantee an internal email.
- Replace the generic payment-stage scanner-candidate message with a stage-aware reason derived from
  the persisted error code.
- Add a bounded attempt/grace rule for retryable pre-push provider states. Escalate repeated failures
  without turning transient provider lag into immediate customer alarm.
- Use a stable blocker fingerprint or incident/episode identifier so scanner retries dedupe the same
  issue while a genuinely new occurrence can create a new notification.

### 2. Add customer-safe address intervention email

Add a customer outbox type with a semantic name such as
`paid_order_fulfillment_address_action_required`.

Rules:

- Enqueue the customer row in the same PayPal-ledger transaction that persists the actionable
  address blocker. Enqueue the existing admin alert in that transaction as well.
- Send only for explicit invalid-address evidence or a verified provider/ledger address mismatch.
  Do not send it for an initial `pending`, unknown, timeout, or indexing-lag result.
- Include the customer name, support reference, a safe order summary, what action is needed, and a
  secure correction/contact CTA.
- Do not include raw Merchize payloads, full payment details, admin-only error text, or an address in
  an email subject.
- Keep deterministic delivery records, attempts, last error, sent time, and admin resend support.
- If customer delivery exhausts the bounded retry policy, create a deduplicated admin action item so
  support can contact the customer through another verified channel.
- A later push-success email remains a separate event and proves that the corrected order actually
  entered fulfillment.

### 3. Add the secure correction and confirmation path

Recommended default:

- The email CTA opens a short-lived, purpose-bound OTP flow before showing any order or address data.
- A customer can submit a corrected address or confirm that the currently displayed address is
  accurate.
- A correction saves the audited ledger override, updates Merchize buyer details only while release
  has not started, verifies the provider read-back, and reruns readiness.
- If Merchize then returns automated `valid`, the scanner may resume automatically when every other
  gate passes.
- If Merchize still reports an explicit invalid status and the customer confirms the address,
  `mark-valid-address` remains a master-admin action. Buyer confirmation alone must not silently call
  the provider mutation or push the order.
- The customer flow must never call PayPal capture, receipt upload, Django payment save, or accepted
  Django process/import again.

### 4. Require address acknowledgment before payment

Move the policy notice before the PayPal payment controls and make it part of payment readiness.

The customer must:

- review a compact rendering of the exact delivery address;
- explicitly confirm that it is complete and correct; and
- acknowledge that correction, replacement, or refund may not be possible once made-to-order
  production starts.

Persist server-side evidence on the paid-order ledger:

- policy identifier/version;
- accepted timestamp;
- checkout surface provenance already captured by the ledger; and
- a PII-safe fingerprint of the acknowledged address rather than another uncontrolled address copy.

Do not use absolute "we are not responsible" language without legal review. The acknowledgment
supports operational clarity but does not replace applicable consumer law.

### 5. Add an audited fulfillment-contact email override

Do not overwrite `PaypalIntent.customerEmail`, PayPal payer data, prior notification recipients, or
the original Django payment identity.

Add a separate semantic correction record/fields:

```txt
fulfillmentContactEmailOverride
fulfillmentContactEmailOverrideReason
fulfillmentContactEmailOverriddenBy
fulfillmentContactEmailOverriddenAt
fulfillmentContactEmailVerifiedAt
```

Rules:

- Validate and normalize the address server-side.
- Require verification of the new email before it becomes the recipient for future customer
  fulfillment notifications. Master-admin emergency override, if allowed at all, requires step-up,
  reason, audit, and an explicit unverified warning.
- Update the pre-push Merchize buyer email through the buyer-details mutation and verify it by
  read-back before reporting success.
- Do not mutate an already pushed provider order automatically.
- Do not replay Django payment save. If Django must expose the corrected operational contact, add a
  dedicated signed and idempotent recipient-update endpoint keyed by
  `djangoPaymentSaveCustomId`; keep that backend contract separate from payment truth.
- Existing sent outbox rows remain immutable. Pending rows for the superseded email must be
  suppressed or replaced through an audited action.

### 6. Make scanner and outbox health observable

Extend the authenticated cron path with:

- a persisted job-run heartbeat keyed by the semantic job name;
- started, completed, failed, and last-success timestamps;
- candidate/result counts and a redacted error summary;
- a per-order lifecycle synchronization lease so overlapping cron requests do not duplicate provider
  fetches;
- bounded dispatch of pending/failed admin and customer outbox rows;
- exponential or stepped retry backoff, maximum attempts, and a visible exhausted/dead-letter state;
  and
- an admin health indicator for last successful payment-recovery, fulfillment-lifecycle, and email
  dispatch runs.

The cron health record must not store raw provider payloads or customer addresses.

### 7. Finish the minimum post-push lifecycle

The existing lifecycle scanner already stores progress, tracking, history, ticket, invoice, and
provider-attention snapshots. The imminent extension must derive durable, idempotent milestones:

- production started;
- tracking available;
- shipment started;
- delivered;
- provider hold/attention;
- delivery exception; and
- progress stuck beyond a product/service-aware threshold.

Use state-aware request profiles:

- Before push: use only identity/readiness endpoints needed for the release decision.
- Pushed but awaiting production: prioritize progress, attention, and invoice maturity.
- In production: prioritize progress and tracking; fetch history/tickets only on exception or
  explicit admin refresh.
- Tracking available/shipping: prioritize package tracking at a slower bounded cadence.
- Delivered/cancelled: perform one terminal reconciliation and stop routine polling.

Normalize multi-package tracking into bounded rows before adding customer shipping emails. Send each
meaningful customer milestone once. Confirm whether Merchize already emails API-imported buyers and
choose one sender before enabling Codex Christi tracking emails; duplicate provider/shop email is not
acceptable.

## Acceptance criteria for this imminent phase

- No readiness blocker can reach `POST /order/external/orders/push`.
- Explicit invalid address and provider-address mismatch each produce one deduplicated admin alert
  and one customer action request.
- Pending/unknown validation does not prematurely email the customer.
- A corrected address is persisted locally, read back from Merchize, revalidated, and reflected in
  the stable receipt before automatic continuation.
- Customer confirmation of a still-provider-invalid address cannot bypass master-admin
  `mark-valid-address`.
- Editing fulfillment contact email preserves immutable payment identity and requires verification.
- Every unexpected paid-order processing failure creates an admin-visible durable alert.
- Failed admin/customer email delivery is retried by the scheduled dispatcher and remains manually
  resendable.
- Admin can see the last successful scanner/outbox run and distinguish "no candidates" from "job did
  not run."
- Lifecycle polling is state-aware, idempotent, bounded, and stops at a terminal state.
- Tests cover the disposition matrix, notification dedupe, outbox retry exhaustion, automatic versus
  admin resume, contact-email verification, cron overlap, and multi-package milestone dedupe.

## Decisions resolved by the alpha release plan

The canonical decisions are now:

1. Use an OTP-protected self-service address correction/confirmation page rather than a
   contact-support-only email.
2. Auto-resume a corrected US address only after provider `valid`; non-US `other`/`others` may
   auto-resume after exact provider read-back while remaining labeled not provider-validated.
   A provider-invalid buyer-confirmed US release stays behind master-admin step-up.
3. Treat `fulfillmentContactEmailOverride` as an operational contact only and preserve original
   payment/Django identity.
4. Codex Christi owns customer lifecycle email for alpha. Do not depend on unconfirmed Merchize
   buyer email.
5. Merchize webhooks are P1. Synchronous reads and scheduled polling must make P0 complete.

---

# 0) 2026-07-21 Authoritative Synchronous Flow

This section supersedes older statements in this guide that equate an HTTP push response with
completed fulfillment. The minimum viable runtime is intentionally synchronous plus scheduled
polling. Merchize webhooks are deferred.

## Completion boundary

```txt
POST /order/external/orders/push HTTP success
  = push command acknowledged

Provider detail/send-to-fulfillment state reports "pushed"
  = production release verified
```

Only the second state may:

- set Merchize Ops `syncStatus = push_to_fulfillment_verified`;
- set `productionGateStatus = push_verified`;
- set `pushVerifiedAt` and `releasedToProductionAt`;
- set the PayPal ledger to `completed`;
- send customer/admin fulfillment-success notifications.

Push verification that is still pending leaves the PayPal row scanner-resumable at
`payment_saved`. It does not replay capture, receipt generation, Django payment save, or an
accepted Django catalog import.

## Required synchronous endpoint chain

Contract status matters:

- `/order/external/orders/*`, `/order/import/artworks`, and `/product/catalog` are documented on
  Merchize's public API Documents page.
- `/order/orders/{merchizeOrderId}/*` seller-operation endpoints are used by the current seller
  dashboard and accept the configured server credential, but their response schemas are not
  documented on that public page. Treat their detailed fields as version-sensitive diagnostic
  evidence: keep bounded parsing, retain raw snapshots server-side only, and fail closed when an
  expected field disappears.
- In particular, `ffm_map_item_status` and `ffm_mapped_catalog_sku` come from undocumented
  seller-operation responses. The public contract independently supports the selected SKU through
  `GET /order/external/orders/order-detail`, catalog import through
  `POST /order/external/orders/catalog`, and catalog variant lookup through
  `GET /product/catalog`. Do not infer item readiness from free-form invoice messages.

| Stage | Endpoint | Runtime use |
| --- | --- | --- |
| Catalog-backed import | `POST /order/external/orders/catalog` | Called through Django `/orders/process/{djangoPaymentSaveCustomId}`. This project intentionally uses catalog import, not generic `POST /order/external/orders`. |
| Canonical lookup | `GET /order/external/orders/order-detail` | Query with `merchizeExternalOrderNumber + fulfillmentIdentifier`; only `data._id` becomes `merchizeOrderId`. |
| In-depth detail | `GET /order/orders/{merchizeOrderId}` | Persists current order/item state and supplies provider address, artwork, order, and push evidence. |
| Address suggestion | `GET /order/orders/{merchizeOrderId}/address-suggestion` | Readiness evidence only. An empty suggestion list is not proof of validity. |
| Buyer details | `GET /order/orders/{merchizeOrderId}/buyerdetails` | Reads existing provider identity/contact fields before correction, verifies persistence after correction, and performs a PII-safe exact-address comparison during pre-push readiness. |
| Address correction | `POST /order/orders/{merchizeOrderId}/buyerdetails` | Requests an admin correction to the already imported provider order. Its success envelope is an acknowledgement, not persistence proof; a buyer-details read-back must match before receipt regeneration and readiness recheck. |
| Buyer display status | `GET /order/orders/{merchizeOrderId}/buyerdetails/display-status` | Adapter is available for diagnostics; not required by the automatic release decision. |
| Mark address valid | `POST /order/orders/{merchizeOrderId}/mark-valid-address` | Master-admin recovery action only. Before mutation, the server reads buyer details and verifies that Merchize still stores the effective ledger address (saved correction first, original checkout snapshot otherwise). It then reads the current `validate_shipping_address` value, including the literal `invalid` state, sends it as `{ status }`, and reruns readiness to verify `mark_valid_address`/valid state. A field mismatch fails closed without logging address values. It never pushes the order. |
| Unfulfilled items | `GET /order/orders/{merchizeOrderId}/unfulfilled` | Captures current item, resolved variant, and catalog evidence. Stale seller-product `is_active`/`is_deleted` flags do not independently mean the resolved catalog variant is unavailable. |
| Provider attention | `GET /order/orders/{merchizeOrderId}/require-attention` | Blocks unresolved provider attention requests. |
| Invoice statistics | `GET /order/external/orders/order-invoice` | Uses `external_number + identifier` and server API-key auth. The documented envelope is `success`, `message`, and `data[]`; each row can contain transaction fee, fulfillment cost, refunds, and charges. A runtime `fulfillment_cost` value of `0` or `null` before push is an awaiting-fulfillment placeholder, not a product/address/artwork failure and not a release blocker. |
| Send/release state | `GET /order/orders/{merchizeOrderId}/send-to-fulfillment-date` | Detects pushed/failed state and participates in push verification. |
| Push | `POST /order/external/orders/push` | Uses `external_number + identifier` by default. HTTP success is acknowledgment only. |
| Push verification | in-depth detail + send state + history + internal progress | Bounded synchronous polling verifies `pushed`, `failed`, or still pending. |

### Address storage and validation are separate evidence

`GET /order/orders/{merchizeOrderId}/buyerdetails` answers whether Merchize currently stores the
same address fields as the effective PayPal-ledger address. It does not answer whether Merchize's
address-verification provider considers that address deliverable.

`GET /order/orders/{merchizeOrderId}` supplies the separate validation evidence:

- `validate_shipping_address = valid`: Merchize validated the US address.
- `validate_shipping_address = street_undefined`: treat this as an invalid-address result whose
  street could not be validated. Do not infer the exact typo or silently reinterpret it as valid.
- `mark_valid_address = true`: the seller explicitly confirmed the address in Merchize. This is
  distinct from an automated `valid` result.
- `validate_shipping_address = other` or `others`: the destination is outside Merchize's US-only
  verification scope. It may proceed as a non-US address, but the UI must not label it "US valid."

Merchize's [Verify US Shipping Address](https://merchize.com/helpdesk/verify-us-shipping-address/)
guide says the feature uses SmartyStreets for US addresses, lists invalid street/city/state among
US-invalid causes, and says non-US addresses are not supported by that check and become "Others."

Every pre-push readiness run with an effective ledger address now performs the buyer-details GET in
the same parallel request batch as the other readiness reads. It compares line 1, line 2, city,
state, postal code, and ISO-2 country code. Only these PII-safe results are persisted:

- `addressReadbackStatus = matched | mismatch | not_checked`
- `addressReadbackMismatchFields`
- the check timestamp

A mismatch adds `MERCHIZE_PROVIDER_ADDRESS_MISMATCH` and blocks release even if
`validate_shipping_address` says `valid`. Conversely, a field match does not erase
`street_undefined` or another provider validation blocker.

### Delivered-order diagnostic baseline

The server-safe API-key reads below were compared on July 23, 2026 against delivered Merchize order
`68226190b15db3b9f938b481`. This order is a diagnostic reference, not a fixture or runtime
dependency. Never hardcode it into workers, release decisions, or customer flows. Re-run the
comparison when Merchize changes a response shape.

| Endpoint | Delivered reference evidence | Pre-push contrast | Runtime interpretation |
| --- | --- | --- | --- |
| `GET /order/orders/{id}` | `validate_shipping_address=valid`, `mark_valid_address=false`, `push_to_fulfillment_progress=pushed`, payment `paid` | A current imported order can also be `valid` and `paid` while progress remains `validating` | Address/payment readiness does not prove production release. |
| `GET /order/orders/{id}/address-suggestion` | Empty list | Empty list was also observed before push | Never use an empty suggestion list as validity proof. |
| `GET /order/orders/{id}/buyerdetails` | Successful buyer object | Same shape before push | Compare normalized address fields; never persist or log the raw PII response. |
| `GET /order/orders/{id}/buyerdetails/display-status` | Successful boolean response | Same response family before push | Display evidence only; not a release gate by itself. |
| `GET /order/orders/{id}/unfulfilled` | Empty list | One current item before push | Empty after fulfillment is expected; pre-push rows supply current product/variant evidence. |
| `GET /order/orders/{id}/require-attention` | Empty list | Empty list can also occur before push | Empty attention is necessary but not sufficient for release. |
| `GET /order/orders/{id}/send-to-fulfillment-date` | `is_failed=false`, `is_pushed=true` | Newer pre-push shape returned `is_failed=false`, `pushed=false` | Normalize both `pushed` and `is_pushed`; either true is release evidence. |
| `GET /order/get-order-progress/{id}` | Six progress nodes, all `done` | Mixed `done` and `pending` nodes | Use for lifecycle verification, not initial address validity. |
| `GET /order/orders/{id}/histories` | Fulfillment-created and tracking-updated events | Address-update/import events without fulfillment completion | Corroborating lifecycle evidence; do not replay mutations from history. |
| `GET /order/orders/{id}/transaction-fee` | `success=false` was still observed | Same before push | This undocumented seller endpoint is not a readiness gate. |
| `GET /order/external/orders/order-progress?code=...` | One result with all nodes `done` | One result with mixed `done`/`pending` | Documented external lifecycle read; prefer it for portable progress checks. |
| `GET /order/external/orders/tracking?code=...` | `success=true`, package `fulfilled`, `has_tracking=true` | `success=false` before a package exists | Absence before shipment is expected, not a production blocker. |
| `GET /order/external/orders/order-invoice?code=...` | One paid USD fulfillment-cost row | A pre-push row can exist without a paid cost status | Refresh after push; do not infer mapping/artwork errors from placeholder cost. |
| `POST /order/external/orders/list-orders-detail` | Reference and pre-push orders both returned | Same batch | Batch equivalent for scanner efficiency. |
| `POST /order/external/orders/list-orders-tracking` | Delivered package evidence present | No package evidence for the pre-push order | Prefer batching for lifecycle scanners. |
| `POST /order/external/orders/list-orders-invoice` | Paid reference row plus pre-push row | Different cost maturity in one response | Classify each row independently by correlation key. |
| `POST /order/external/orders/list-orders-ticket` | Successful per-order response wrappers | No blocking ticket was observed | Ticket reads are support evidence, not automatic mutation authority. |

When comparing a recovery order with this baseline, record the observation time. Provider state is
mutable: a previously captured `street_undefined` response can later become `valid` after a
correction or verification cycle. The admin UI must show the latest persisted check time and must
not present the effective ledger address itself as a live provider read-back.

The provider's seven-day rule is enforced before push. Orders whose provider `paid_at` is more
than seven days old require a master-admin production release. That step-up bypasses only the
configuration/age gate; address, explicit current item evidence, explicit artwork-required state,
provider-attention blockers, and a rejected invoice request remain non-bypassable.

## Catalog template orders versus artwork-set orders

The public API documents two separate contracts:

- `POST /order/external/orders/catalog` requires `items[].merchize_sku` and
  `items[].image`. The image is a preview. `design_front`, `design_back`, `design_sleeve`, and
  `design_hood` are optional because a stored Merchize product/template can already carry the
  production configuration.
- `POST /order/import/artworks` targets an existing order item by `items[].id` and imports one or
  more explicit artwork sets. This is a separate creation/repair mode, not a universal follow-up
  requirement for catalog-backed orders.

Current Codex Christi checkout uses the catalog-backed contract. Readiness therefore applies these
rules:

1. A generic order-level `artwork_status = missing` does not block when every unfulfilled item has
   a resolved active catalog variant/template. Persist `artworkReviewStatus = catalog_managed`.
2. Empty front/back/sleeve/hood upload slots in the seller UI do not prove that the stored catalog
   template lacks production assets.
3. Artwork blocks only when the item is not demonstrably catalog-backed or Merchize returns
   explicit artwork-required evidence from the order/item, importer, attention, or push response.
4. A displayed catalog SKU and catalog price prove that Merchize can render stored product
   information; they do not prove that a current fulfillment invoice was generated.
5. Product mapping blocks only on explicit direct item, resolved variant, or catalog evidence.
   Free-form invoice `message` text must not create a product blocker or tell an operator to
   reselect a product.
6. The documented invoice endpoint is accounting evidence. Before push, a successful row with
   `fulfillment_cost: 0` or `null` means `awaiting_fulfillment`; after push it remains `pending`
   until a structured cost object appears. Refresh it after the push acknowledgement/verification.
7. The public documentation provides a success example but no stable error-code taxonomy. Treat
   `success: false` as the generic retryable `MERCHIZE_INVOICE_LOOKUP_FAILED`, retain the redacted
   response server-side, and do not parse its message into unrelated readiness categories.

## Scheduled synchronous lifecycle reconciliation

The existing authenticated cron route remains the single scheduler entry point:

```txt
POST /next-api/jobs/paypal-tx-ledger-recovery-scan
```

Its response contains separate `paymentRecovery` and `fulfillmentLifecycle` results. For each
provider-verified, non-delivered order, the fulfillment lifecycle pass refreshes:

| Evidence | Endpoint |
| --- | --- |
| Canonical order and normalized items | `GET /order/external/orders/order-detail`, then `GET /order/orders/{merchizeOrderId}` |
| Address, item, artwork, invoice-envelope, and attention health | the synchronous readiness endpoints listed above |
| External progress | `GET /order/external/orders/order-progress` |
| Tracking/packages | `GET /order/external/orders/tracking` |
| Invoice, fulfillment charges, refunds, and surcharges | `GET /order/external/orders/order-invoice` |
| Existing provider tickets | `POST /order/external/orders/list-orders-ticket` |
| Provider history | `GET /order/orders/{merchizeOrderId}/histories` |
| Internal progress | `GET /order/get-order-progress/{merchizeOrderId}` |
| Send-to-fulfillment state | `GET /order/orders/{merchizeOrderId}/send-to-fulfillment-date` |
| Transaction fee | `GET /order/orders/{merchizeOrderId}/transaction-fee` |

Polling stops after a terminal delivery/cancellation state. A non-retryable health issue creates a
deduplicated admin warning. The same snapshot action failing three times creates a separate
reconciliation warning. Neither path rolls back payment or replays production release.

## Admin evidence read model and request budget

Implemented on 2026-07-22:

- The paid-order recovery detail page renders one **Fulfillment Evidence** panel from the persisted
  `MerchizeFulfillmentOrder` row.
- Opening or reloading the admin detail page does not call Merchize. It performs the existing
  PayPal-ledger query plus one Merchize Ops database query.
- The query selects normalized status and freshness columns only. It does not select or serialize
  raw provider JSON payloads, customer addresses, package contents, invoice line items, or tickets.
- The readiness section shows Address, Products, Artwork, Invoice, Attention, Age Gate, Push Command,
  and Push Verification.
- The operational section shows the latest normalized Progress, Tracking, Invoice, and Ticket
  snapshot freshness. The pre-push invoice row is observational unless its envelope is rejected;
  ticket retrieval does not inherit the Attention release-gate label.
- A missing timestamp is shown as not synced/not checked. The UI must not infer provider success
  merely because no blocker payload is present.

Provider I/O remains confined to:

1. The paid fulfillment runner while an order is moving toward production.
2. The explicit **Verify Provider State** admin action.
3. The existing authenticated lifecycle scanner.

There is no client polling, route prefetch side effect, React page-load fetch to Merchize, or
per-tile provider request. Readiness calls execute concurrently, and operational snapshot calls
execute concurrently within their existing groups. The low-volume scanner retains single-order
calls for correlation and failure isolation; the documented list endpoints remain the future batch
optimization when order volume justifies it.

All adapter calls use the shared server-only header builder. When configured,
`MERCHIZE_API_KEY` is sent as `X-API-KEY`; `x-store-id` and Bearer authorization are additive.
No `x-refresh-token` is used. API-key-only access should be verified against every seller-detail
endpoint during deployment preflight before removing the existing optional Bearer credential.

Deferred evidence presentation and request optimizations:

- Do not load raw snapshot JSON into the default detail page. Normalize package counts, tracking
  numbers, invoice totals, ticket counts, and provider-history milestones into bounded columns or
  dedicated child tables before adding richer displays.
- Do not add automatic browser polling. Use explicit refresh or the scheduled scanner, then
  revalidate the server-rendered page.
- Do not switch the lifecycle scanner to list/batch endpoints until batching preserves
  `external_number + identifier` correlation and per-order failure isolation.
- Do not add separate calls for each visual tile. A new tile must use persisted evidence or be
  folded into an existing provider request.
- Do not expose product replacement, artwork upload, ticket mutation, hold/resume, or cancellation
  merely to make the evidence panel actionable. Those mutations require their own authorization,
  confirmation, audit, and rollback contracts.
- Do not add webhook-driven freshness in this phase. Webhook ingestion remains deferred below.

## Public API endpoints indexed but not automatic

- `POST /order/external/orders/list-orders-detail`,
  `POST /order/external/orders/list-orders-progress`,
  `POST /order/external/orders/list-orders-tracking`, and
  `POST /order/external/orders/list-orders-invoice` are batch optimization endpoints. Detail,
  tracking, and invoice adapters exist; the current low-volume scanner intentionally uses the
  single-order calls for simpler correlation and failure isolation.
- `POST /order/external/orders/update-order-status` supports `hold` and `resume`. The server-only
  adapter exists, but UI exposure remains deferred until reason capture, confirmation, and master
  step-up are wired.
- `POST /order/external/orders/cancel` has a server-only adapter but is outside automatic flow and
  must not be exposed without explicit scope approval.
- `POST /order/import/artworks` can repair an explicit artwork-set order using provider order-item
  IDs. It is not automated in this phase because source asset ownership and item-to-side mapping
  require explicit admin review. Do not invoke it merely because a catalog-backed order reports a
  generic missing-artwork status.
- `GET /product/catalog` and `GET /product/products/{productId}/all-variants` can support future
  catalog repair diagnostics. Product replacement/remapping is deliberately deferred under the
  product-change scope boundary.
- Ticket create/update/reopen/resolve endpoints are deferred. Current scope retrieves existing
  tickets for visibility but does not create or mutate support tickets automatically.

## Webhooks deliberately deferred

The live Merchize documentation was indexed for these events:

```txt
ORDER.CREATED
ORDER.CHANGED.TRACKING
ORDER.CHANGED.SHIPMENT
ORDER.CHANGED.PROGRESS
ORDER.CHANGED.PROGRESS_STATUS
ORDER.PAYMENT.TRANSACTION_FEE
ORDER.PAYMENT.FULFILLMENT_COST
ORDER.PAYMENT.FULFILLMENT_COST_PAID
ORDER.PAYMENT.REFUND
ORDER.PAYMENT.SURCHARGE
ORDER.ISSUE.UPDATED
ORDER.INVALID.ADDRESS
ORDER.IMPORTER.ERROR
```

The documented delivery contract includes `merchize-webhook-key`, `event_id`, `event_time`,
`resource.external_number`, and `resource.identifier`. No receiver, event table, secret env, or
registration workflow is implemented in this phase. Future webhook work must add secret
verification, event-ID idempotency, raw-payload access controls, unmatched-event reconciliation,
replay tooling, and dashboard/manual registration guidance. Refund and surcharge events must be
observational only until financial-operation scope is explicitly approved.

---

# 1) Scope Boundary

## Corrected 2026-06 scope

The previous wording treated Merchize Fulfillment Ops as beginning only after an accepted Django handoff. That is too narrow.

The corrected domain is:

```txt
runPaidFulfillmentProcessing(orderToken)
```

This is the semantic replacement for the older `runPostProcessing(orderToken)` name. Do not keep `runPostProcessing` as an alias-only fallback. Runtime callers should use `runPaidFulfillmentProcessing`.

Paid order fulfillment processing starts when PayPal capture already exists and the server has enough ledger state to continue without the shopper's browser. It includes:

1. Receipt generation/upload.
2. Django payment save.
3. Merchize catalog-backed fulfillment payload validation.
4. Catalog external order import.
5. Push-to-fulfillment.
6. Provider lookup/status/tracking/attention checks.
7. Admin recovery and reconciliation.

## Provider start point

The Merchize-specific provider stages start after Django payment save returns:

```txt
djangoPaymentSaveCustomId
```

That value is the path value for:

```txt
POST /orders/process/{custom_id}
```

In current Django language, `{custom_id}` is returned by:

```txt
POST /orders/order-payment
```

The local codebase names this value:

```txt
djangoPaymentSaveCustomId
```

## Does not own directly

Merchize Fulfillment Ops does not own the payment side effects themselves:

- Checkout form state.
- Django order-intent OTP creation or verification.
- PayPal order creation.
- PayPal authorization or capture.
- PayPal webhook verification.
- Customer-side unresolved paid checkout warning.

Those remain owned by the PayPal TX ledger and checkout recovery flows. The paid order fulfillment runner may orchestrate receipt upload and Django payment save as prerequisites, but Merchize-specific code must not replay PayPal capture, receipt upload, or Django payment save after those artifacts already exist.

## Owns

Merchize Fulfillment Ops owns the provider lifecycle inside paid order fulfillment processing:

- Catalog-backed external order import using Merchize catalog/SKU data.
- Push-to-fulfillment as an explicit success boundary.
- Merchize lookup by external number.
- Merchize order ID extraction.
- In-depth Merchize order detail fetch.
- Merchize item snapshot persistence.
- Duplicate-order reconciliation.
- Merchize status tracking.
- Merchize tracking sync.
- Production readiness checks before release/open.
- Address suggestion, address review, and buyer detail correction workflow.
- Documented invoice-statistics capture plus supplemental transaction-fee diagnostics.
- Order progress and order history sync.
- Admin and customer notification triggers for provider-side blockers.
- Future Merchize actions such as change product, change processing, hold, cancel, escalation, and manual Merchize order linking.
- Admin-facing Merchize diagnostics and operational actions.

---

# 2) Current Contract Knowledge

## Django process response can be accepted even with an informational message

The Django process endpoint can return:

```txt
status: 201
success: true
message: "Order processed successfully."
data.processing_status: "completed"
data.error_message: "Order created but details not available"
```

This is not automatically a failure. It means Django accepted the process step. Under the corrected scope, it counts as final paid-order fulfillment success only if the Django process contract confirms that it performed or accepted the Merchize push-to-fulfillment stage, not merely catalog import.

Implementation rule:

- Do not classify the known informational message as `fulfillment_failed` when Django also reports `success: true` and `processing_status: completed`.
- Do not replay PayPal capture, receipt upload, or Django payment save for this response.
- If Django's process endpoint cannot prove push-to-fulfillment was accepted, add an explicit server-only push stage before marking the paid order fulfillment runner complete.

## Merchize duplicate can be idempotent

When Merchize says an order is duplicated, it can mean Merchize already has an order for that external number. That should be treated as a reconciliation signal first, not as a new unrecoverable failure.

Implementation rule:

- If the Merchize duplicate response includes enough Merchize data to identify or lookup the existing order, move to lookup/detail sync.
- If the duplicate response has no usable identifier and lookup fails, create an admin-visible reconciliation issue.

## Django wrapped Merchize response may contain Merchize identifiers

The Django process response may wrap Merchize data with a process-time `_id`, status, enqueue flags, and item snapshots.

Implementation rule:

- Extract the provider-facing `order_id` as `merchizeExternalOrderNumber` when present.
- Do not treat the wrapped process `response_data.data._id` as the in-depth detail path ID.
- The authoritative `merchizeOrderId` for `GET /order/orders/{id}` must come from `resp.data._id` returned by `GET /order/external/orders/order-detail?external_number=...`.
- That same `merchizeOrderId` is the default Merchize platform identifier for later POD actions such as view, edit, pause, change product, change processing, and tracking/status operations.
- Persist raw Merchize snapshots only in access-controlled DB fields.
- Show redacted summaries in admin UI, logs, and notification emails.

## PII handling

Merchize payloads can contain full names, email, phone, and shipping addresses. Do not copy real customer payload examples into guides, logs, screenshots, issue summaries, or emails.

Allowed in guides and logs:

- `orderToken`
- `djangoPaymentSaveCustomId`
- Merchize order ID
- Merchize status
- Merchize action type
- redacted customer email such as `c***@domain.com`
- counts and status summaries

Not allowed in guides and logs:

- Full customer address.
- Full customer phone.
- Full customer email unless explicitly needed in a secured admin UI.
- Raw Merchize JSON in console logs.

---

# 2A) Exported Endpoint Coverage

This section is based on the exported Postman folder named `New Order Placement via External API` inside the `bo-group-2-2.merchize.com` collection, plus the adjacent HAR-derived Merchize order support collection.

Do not commit the raw Postman exports. They contain test payloads, example addresses, emails, and auth variables. The implementation should store only redacted summaries in logs and guide examples.

## Credential reality and endpoint priority

The exported collections include endpoints that appear to use more than one auth style:

- Merchize external-order API endpoints that are expected to work with a server-side API key.
- Merchize dashboard/support-view endpoints that include `x-store-id` and may also require a dashboard refresh/session token.
- Seller/product-management endpoints that appear closer to the provider's internal dashboard workflow.

Current known credential state:

- `x-store-id` is available.
- `x-refresh-token` is not available.
- The configured server credential was verified with read-only calls on 2026-07-21 for the seller
  order-detail, address, unfulfilled-item, attention, cost, history, progress, transaction-fee, and
  send-to-fulfillment endpoints. No browser session token was used.
- The synchronous adapter may use those verified endpoints with `MERCHIZE_API_KEY` or the existing
  server bearer credential. It must fail closed if a deployment later requires `x-refresh-token`.
- Do not add any new dashboard-only endpoint to an automatic worker until it is separately verified
  with stable server authentication.

Implementation rule:

- Prioritize endpoints that can run from the server with `MERCHIZE_API_KEY` or another official server credential.
- Treat `x-store-id` as store context, not proof of authorization by itself.
- Do not scrape, replay, or persist browser dashboard session tokens as an integration strategy.
- If a useful endpoint requires `x-refresh-token`, document it as blocked/pending provider auth and keep the admin UI fallback as "open in Merchize dashboard" or "manual provider check".
- The goal is not to rebuild the full Merchize UI. The goal is to avoid logging into Merchize for routine Codex Christi order operations.

Essential first-party needs for Codex Christi:

- Confirm Merchize received the order.
- Resolve `merchizeExternalOrderNumber` into canonical `merchizeOrderId`.
- Fetch the in-depth order detail snapshot.
- See whether the order is pending, held, open, fulfilled, failed, or requires attention.
- Check address validity and save address corrections when safe.
- Capture invoice state before release without requiring a generated pre-push invoice.
- Hold or open/release production with admin reason and audit history.
- Track progress/history enough to notify support and customers responsibly.

Non-essential for the first implementation:

- Full Merchize dashboard parity.
- Product catalog browsing inside order ops.
- Product replacement/change-product flows.
- Processing-method changes.
- Direct Merchize order creation outside Django's current handoff.
- Refund/dispute operations, which belong to PayPal post-sale tooling.

## Core external-order flow

These endpoints define the core catalog-backed fulfillment chain:

```txt
POST /order/external/orders/catalog
POST /order/external/orders/push
GET  /order/external/orders/order-detail?external_number={externalNumber}&identifier={fulfillmentIdentifier}
GET  /order/orders/{merchizeOrderId}
```

Operational meaning:

- `POST /order/external/orders/catalog` is Merchize's direct external-order import endpoint.
- `POST /order/external/orders/push` is Merchize's push-to-fulfillment endpoint.
- Catalog import is not final fulfillment success by itself. Push HTTP acknowledgment is also not final; completion requires provider state to verify that the order was pushed.
- In the current Codex Christi runtime, Django `/orders/process/{custom_id}` is treated as catalog-backed process acceptance/import. Next.js performs the explicit server-only Merchize push stage before setting the paid order fulfillment runner complete.
- A future Django contract may issue the push command directly, but Next.js must still verify final provider state before completing the paid-order ledger.
- Merchize Ops should not replay direct Merchize creation during normal sync unless the target stage is explicitly incomplete and idempotency checks pass.
- Direct creation or manual linking belongs to admin repair flows and must require admin confirmation and an audit reason.
- `external_number` is the provider-facing order string, currently the `ORD-...` value from Django's wrapped process response.
- `resp.data._id` from the external-number lookup is the canonical `merchizeOrderId`.
- All later Merchize actions should use `merchizeOrderId`, not Django's wrapped process `_id`.

Push request shape:

```txt
POST /order/external/orders/push
{
  "order": {
    "code": "{merchizeOrderCode}",
    "external_number": "{merchizeExternalOrderNumber}",
    "identifier": "{fulfillmentIdentifier}"
  }
}
```

Implementation rules:

- Prefer `external_number + identifier` for Codex Christi orders.
- Use `code` when Merchize already returned a stable internal order code and the external number is ambiguous.
- Name the local variable `fulfillmentIdentifier`, then map it to Merchize's `identifier` field at the adapter boundary.
- Do not use `djangoPaymentSaveCustomId` as the external number.

## Production control endpoints

These external-order endpoints control provider order release and admin repair actions:

```txt
POST /order/external/orders/update-order-status
POST /order/external/orders/cancel
```

Known status payload meanings:

- `action = hold`: pause order progress for edit/review.
- `action = resume`: resume order progress after review.
- `cancel` is a destructive provider mutation and must stay behind an admin reason, audit log, and step-up confirmation before UI exposure.

Implementation rule:

- Opening/releasing production is a dangerous admin action unless the automatic production gate has passed.
- Hold/open actions must record an admin reason and must create an admin action history row.
- Future production auth should require WebAuthn/passkey step-up for open/resume, hold, cancel, and manual resolution.

## External operational snapshots

These server-auth endpoints feed synchronous reconciliation after verified production release:

```txt
GET  /order/external/orders/order-progress
GET  /order/external/orders/tracking
GET  /order/external/orders/order-invoice
POST /order/external/orders/list-orders-detail
POST /order/external/orders/list-orders-tracking
POST /order/external/orders/list-orders-invoice
```

Implementation rules:

- Use `external_number + identifier` for single-order queries when the Codex Christi external number is known.
- Persist progress into `merchizeProgressPayload`, tracking into `merchizeTrackingPayload`, and invoice/cost state into `merchizeFulfillmentCostPayload`.
- Snapshot sync failures should create failed sync attempts and admin-visible reconciliation state, but they should not undo a successful push-to-fulfillment completion.

## Current post-push notifications and reconciliation gaps

The runtime now records successful push-to-fulfillment in Merchize Fulfillment Ops, completes the PayPal TX ledger row, and creates tracked success notifications.

Implemented customer-facing behavior:

- After `verifyMerchizeFulfillmentPush(...)` confirms provider state, the runner enqueues and sends `paid_order_fulfillment_push_verified`.
- Customer delivery uses `CustomerNotificationOutbox` in the PayPal TX ledger so the send attempt is durable and visible in admin detail.
- Customer copy stays safe: payment received, the order is being prepared, support reference is `orderToken`, and receipt link when available.
- Customer emails must not include raw provider payloads, full internal provider IDs, or address data beyond what already belongs in the customer confirmation context.

Implemented admin-facing behavior:

- Verified provider release enqueues `paid_order_fulfillment_push_verified` in `AdminNotificationOutbox`.
- Success emails route through `paid_order_fulfillment_success`, falling back to `ORDER_RECOVERY_ADMIN_EMAILS` only when Admin Ops recipients are unavailable.
- Failure/blocking/attention states still route through `paid_order_fulfillment_issues`.
- Admin success rows include `orderToken`, `merchizeExternalOrderNumber`, `merchizeOrderId` when known, `merchizeOrderCode`, and the recovery detail URL.

Remaining post-push escalation work:

- Convert progress/tracking/invoice snapshot failures into admin-visible reconciliation states when they persist after retry.
- Add explicit classification rules for `attention_required`, `blocked`, `address_review_required`, `product_unavailable`, `tracking_synced`, and `reconciled`.
- Add customer tracking/update emails only after tracking data is present and customer-safe.

Remaining dangerous admin action work:

- Push-disabled manual release has master-admin step-up, reason capture, confirmation, and audit logging.
- Pause/resume/cancel provider actions still need reason capture, audit logging, confirmation, and eventual step-up auth before production use.
- Cancel remains out of automatic workflow scope.

## Semi-real provider test with push disabled

Current runtime status:

- `MERCHIZE_FULFILLMENT_PUSH_ENABLED` is the server-only push gate. Empty or missing means enabled. Valid explicit values are `true` and `false`.
- When `MERCHIZE_FULFILLMENT_PUSH_ENABLED=false`, the runner completes the payment-owned stages, calls Django payment save, calls Django fulfillment process/import, registers the accepted Merchize process, runs external-number lookup/detail sync when safe, and stops before `POST /order/external/orders/push`.
- If the external-number lookup temporarily returns `success: false` with message `Order is being processed`, treat it as provider indexing lag, not a failed order. Retry briefly, then persist Merchize Ops `syncStatus = lookup_pending` with `lastSyncErrorCode = MERCHIZE_LOOKUP_PENDING_PROVIDER_PROCESSING`, leave the PayPal ledger scanner-resumable, and do not send a critical recovery email for that first pending state. Escalate to `MERCHIZE_LOOKUP_NOT_FOUND` only after the bounded retry/grace policy is exhausted.
- The stopped state is explicit: PayPal ledger `status = fulfillment_attention_required`, `lastErrorCode = MERCHIZE_PUSH_DISABLED_BY_CONFIG`, Merchize Ops `syncStatus = push_to_fulfillment_disabled`, and `productionGateStatus = push_disabled`.
- The stopped state creates a durable admin notification outbox row and attempts to send the configured internal email, because this is an operator action item.
- The customer confirmation page does not expose provider internals. It shows the customer-safe manual-review/preparation state and the `orderToken` support reference.
- The confirmation page must not show raw Merchize IDs, raw Django process payloads, customer address payloads, or admin-only error detail.

Implemented admin override behavior:

- Admin recovery shows that provider push is disabled by configuration and offers a master-admin-only manual release on the order detail page.
- Manual release requires master admin authorization, fresh password step-up, browser confirmation, and an admin reason.
- Manual release calls `runPaidFulfillmentProcessing(orderToken, { overrideMerchizeFulfillmentPushDisabled: true })`.
- The runner lease and existing ledger fields prevent replay of PayPal capture, receipt generation, Django payment save, and an already accepted Django process/import.
- On override success, Merchize Ops first records command acknowledgment, then verifies provider state. Only `push_verified` sets `releasedToProductionAt`, completes the PayPal ledger, and sends customer/admin success notifications.
- On override failure, Merchize Ops persists `push_failed` when the provider push failed, the row remains recoverable, and the internal recovery notification/email path stays active.

Implemented customer/admin notification behavior:

- Customer email after automatic or manual provider push verification is tracked in `CustomerNotificationOutbox`.
- Admin emails are sent for push-disabled, push-failed, true lookup-failed/not-found, provider-rejected, payload-invalid, and future attention-required states.
- Do not send a critical admin email for `MERCHIZE_LOOKUP_PENDING_PROVIDER_PROCESSING`; show it as a provider-sync pending state and let scanner/admin retry. Escalate to `MERCHIZE_LOOKUP_NOT_FOUND` only after the provider no longer reports processing or after the bounded grace/retry policy is exhausted.
- Admin success emails for pushed orders route through `paid_order_fulfillment_success` so they can be separated from the higher-signal `paid_order_fulfillment_issues` stream.

## Current UI-led end-to-end verification runbook

Use this runbook to test the committed flow from the storefront UI, then verify the server state. This is for dev/staging only.

Safety rule:

- Do not run this against a live Merchize store unless the test order is intentionally allowed to be pushed to fulfillment.
- Set `MERCHIZE_FULFILLMENT_PUSH_ENABLED=false` for a semi-real checkout that should stop before provider push.
- The Django `/orders/process/{custom_id}` stage can create/import the external order before the Next.js Merchize Ops push stage runs. Use a staging Django backend or a provider mock if the test must not touch production fulfillment.

Preflight commands:

```bash
yarn prisma:paypalTxLedger:generate:dev
yarn prisma:merchizeFulfillmentOps:generate:dev
yarn prisma:adminOpsLedger:generate

PAYPAL_TX_LEDGER_NEON_BRANCH=dev yarn prisma migrate status --schema prisma/shop/paypal/paypalTXLedger.schema.prisma
MERCHIZE_FULFILLMENT_OPS_NEON_BRANCH=dev yarn prisma migrate status --schema prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOps.schema.prisma
yarn prisma migrate status --schema prisma/adminOpsLedger/adminOpsLedger.schema.prisma

./node_modules/.bin/tsc --noEmit --pretty false
yarn lint
```

Local env switches for a UI-led run:

```bash
PAYPAL_PAYMENT_MODE=sandbox
NEXT_PUBLIC_PAYPAL_PAYMENT_MODE=sandbox
SHOP_OPS_DATA_TARGET=dev
SHOP_OPS_ALLOW_LOCAL_PRODUCTION_MUTATIONS=false
PAYPAL_TX_LEDGER_ENABLE_CAPTURE_ROUTE_RUNNER=true
NEXT_PUBLIC_SITE_URL=http://localhost:3000
MERCHIZE_FULFILLMENT_PUSH_ENABLED=false # semi-real no-push test
```

The per-schema `*_NEON_BRANCH` variables shown in the Prisma preflight commands select migration
targets only. Do not use them as independent runtime switches once `SHOP_OPS_DATA_TARGET` is set.

For an exceptional supervised production recovery from localhost, start a separate process:

```bash
SHOP_OPS_DATA_TARGET=prod \
SHOP_OPS_ALLOW_LOCAL_PRODUCTION_MUTATIONS=true \
yarn dev --port 3001
```

The production pooled URLs must already be configured. The admin UI must show `Production data`
before the action, and each supported mutation still requires master-admin password confirmation.

The confirmation status route is read-only. With webhooks/ngrok off, post-capture work is triggered by the capture route runner or by the scheduled recovery scanner/cron.

Provider safety setup:

- Safe full UI test: PayPal sandbox + Django staging/test backend + Merchize staging/test store.
- Safe mocked provider test: PayPal sandbox + Django staging/mock that returns the accepted process contract + Next.js Merchize API base URL pointed to a local mock that implements the external-order lookup, detail, push, progress, tracking, and invoice endpoints.
- Unsafe test: PayPal sandbox + production Django + live Merchize base URL. This can still create/import and push a real order.

For a Next.js-side Merchize mock, set server-only values like these in a local-only env file:

```bash
MERCHIZE_BO_API_BASE_URL=http://127.0.0.1:8787
MERCHIZE_API_KEY=dev-mock
```

The mock must return successful JSON for these current calls:

```txt
GET  /order/external/orders/order-detail?external_number=...&identifier=...
GET  /order/orders/{merchizeOrderId}
POST /order/external/orders/push
GET  /order/external/orders/order-progress?external_number=...&identifier=...
GET  /order/external/orders/tracking?external_number=...&identifier=...
GET  /order/external/orders/order-invoice?external_number=...&identifier=...
```

Storefront UI steps:

1. Start the app with `yarn dev`.
2. Open `http://localhost:3000/shop`.
3. Add a low-risk test item to cart.
4. Check out with a PayPal sandbox buyer account.
5. Wait for the redirect to `/shop/checkout/confirmation/{orderToken}`.
6. Keep the confirmation page open until it reaches either `Payment confirmed` or the manual-review state.
7. Copy the support reference. That value is the `orderToken`.

Expected current successful path:

- Confirmation page reaches `Payment confirmed`.
- Receipt download is available when receipt upload completed.
- PayPal ledger row has `status = completed` and `processingCompletedAt` set.
- Merchize Fulfillment Ops row has `syncStatus = push_to_fulfillment_verified`, `productionGateStatus = push_verified`, and both `pushVerifiedAt` and `releasedToProductionAt` set.
- Sync attempts include `registration`, `external_lookup`, `detail_lookup`, `push_to_fulfillment`, and best-effort operational snapshot attempts for progress, tracking, and invoice.
- Customer notification outbox has `paid_order_fulfillment_push_verified` for the customer recipient.
- Admin notification outbox has `paid_order_fulfillment_push_verified` for each configured success recipient.

Expected current failure path:

- Provider rejection, lookup failure, missing external number, push failure, or local payload validation stops the runner before `completed`.
- Confirmation page shows the manual-review customer-safe state.
- PayPal ledger row is `fulfillment_failed` or `fulfillment_blocked`.
- Admin notification outbox receives a row and the runner attempts to send the configured admin email.
- Admin recovery can retry the remaining paid fulfillment runner without replaying PayPal capture.

Expected push-disabled path:

- Confirmation page shows the customer-safe manual-review/preparation state, not final fulfillment success.
- PayPal ledger row has `status = fulfillment_attention_required`, `processingCompletedAt = null`, and `lastErrorCode = MERCHIZE_PUSH_DISABLED_BY_CONFIG`.
- Merchize Fulfillment Ops row has `syncStatus = push_to_fulfillment_disabled` and `productionGateStatus = push_disabled`.
- Admin notification outbox receives a warning row for the stopped state and the runner attempts to send the configured admin email.
- No customer success email is sent before manual release.
- The admin detail page shows the master-admin manual release form. Successful release moves the order to the successful path above without replaying payment-owned stages.

Server verification without dumping raw payloads:

```bash
curl -s "http://localhost:3000/next-api/paypal/tx-ledger/payments/<orderToken>/status"
```

PayPal ledger check:

```sql
select
  "orderToken",
  "status",
  "djangoPaymentSaveCustomId",
  "merchizeFulfillmentProcessingId",
  "merchizeProviderOrderCode",
  "processingCompletedAt",
  "lastErrorCode",
  "lastErrorMessage"
from "PaypalIntent"
where "orderToken" = '<orderToken>';
```

Merchize Fulfillment Ops check:

```sql
select
  "orderToken",
  "merchizeExternalOrderNumber",
  "merchizeOrderId",
  "merchizeOrderCode",
  "syncStatus",
  "productionGateStatus",
  "progressStatus",
  "deliveryStatus",
  "costReviewStatus",
  "releasedToProductionAt",
  "lastSyncErrorCode",
  "lastSyncErrorMessage"
from "MerchizeFulfillmentOrder"
where "orderToken" = '<orderToken>'
order by "updatedAt" desc;
```

Sync attempt check:

```sql
select
  "action",
  "status",
  "errorCode",
  "errorMessage",
  "startedAt",
  "finishedAt"
from "MerchizeFulfillmentSyncAttempt"
where "orderToken" = '<orderToken>'
order by "createdAt" asc;
```

Admin notification check:

```sql
select
  "type",
  "stage",
  "errorCode",
  "severity",
  "status",
  "recipient",
  "sentAt",
  "lastErrorMessage"
from "AdminNotificationOutbox"
where "orderToken" = '<orderToken>'
order by "createdAt" asc;
```

Customer notification check:

```sql
select
  "type",
  "status",
  "recipient",
  "sentAt",
  "lastErrorMessage"
from "CustomerNotificationOutbox"
where "orderToken" = '<orderToken>'
order by "createdAt" asc;
```

Do not select raw payload columns during normal verification. Use the admin detail UI or a redacted debug path when payload inspection is required.

## Address and buyer detail endpoints

These endpoints support address review and correction:

```txt
GET  /bo-api/order/orders/{merchizeOrderId}/address-suggestion
POST /bo-api/order/orders/{merchizeOrderId}/buyerdetails
```

Implementation rule:

- Address suggestion should run before automatic production release.
- If Merchize returns an address suggestion, validation issue, unsupported country, or ambiguous result, set `addressReviewStatus = review_required`.
- Customer emails can request address confirmation, but raw provider payloads should never be sent to the customer.
- Admin/customer address corrections must be persisted as an address review record before calling `buyerdetails`.
- Country changes are cost-sensitive. After any country or postal-code change, rerun cost/fee checks before opening production.

## Cost and fee endpoints

The documented external-order invoice endpoint is the runtime accounting source:

```txt
GET /order/external/orders/order-invoice?external_number={externalNumber}&identifier={identifier}
X-API-KEY: {serverApiKey}
```

The successful response is an envelope with `success`, optional `message`, and `data[]`. Each row
can contain `code`, `external_number`, `identifier`, `transaction_fee`, `fulfillment_cost`,
`fulfillment_refund`, and `fulfillment_charge`. Although the documentation models
`fulfillment_cost` as an object, live pre-push responses have returned numeric `0` or `null`.
Those values mean that no structured fulfillment invoice exists yet; they do not prove a variant,
address, artwork, or financial failure.

The seller-operation transaction-fee endpoint remains supplemental diagnostic evidence:

```txt
GET /bo-api/order/orders/{merchizeOrderId}/transaction-fee
```

The HAR-derived collection also contains:

```txt
GET /bo-api/order/orders/{merchizeOrderId}/fulfillment-invoice
GET /bo-api/order/orders/{merchizeOrderId}/ioss/display
```

Implementation rule:

- `success: false` from the documented invoice request creates a generic retryable invoice-sync
  blocker. Do not branch on undocumented message strings.
- Numeric `0`, `null`, an empty cost object, or a successful empty row before push is
  `awaiting_fulfillment` and does not block release.
- After push, refresh once through the operational snapshot path. A still-empty cost becomes
  `pending` and can be reconciled by the lifecycle scanner without replaying push or payment.
- A structured cost object is `available`; a structured object with `status = paid` is `paid`.
- A transaction-fee response that indicates unpaid/invalid state is diagnostic until its
  seller-operation contract is verified; it must not override the documented invoice result.
- If cost changes after address correction, put the order in admin review before charging, refunding, or asking the customer for an extra payment.
- IOSS/tax display data may be captured only as provider-side operational evidence where relevant.
  It is outside P0.2, must not enter the canonical order, PayPal, or receipt totals, and must not be
  presented as tax collected. Do not show it to customers until its meaning and display policy are
  separately understood and approved.

## Progress, history, and support-view endpoints

These endpoints provide provider lifecycle visibility:

```txt
GET /bo-api/order/orders/{merchizeOrderId}/histories
GET /bo-api/order/get-order-progress/{merchizeOrderId}
```

The HAR-derived collection also contains:

```txt
GET /bo-api/order/orders/{merchizeOrderId}/send-to-fulfillment-date
GET /bo-api/order/orders/{merchizeOrderId}/unfulfilled
GET /bo-api/order/orders/{merchizeOrderId}/buyerdetails
GET /bo-api/order/orders/{merchizeOrderId}/buyerdetails/display-status
GET /bo-api/order/orders/{merchizeOrderId}/require-attention
GET /bo-api/order/orders/{merchizeOrderId}/tags
GET /bo-api/order/orders/{merchizeOrderId}/notes
```

Implementation rule:

- Progress/history sync should be separate from payment-ledger completion.
- Progress events should drive admin state and customer-safe status updates.
- `require-attention`, unfulfilled items, buyer display status, tags, and notes should be treated as support signals.
- If these endpoints require `x-refresh-token` or another dashboard-session credential, do not include them in the automatic worker until Merchize provides a stable server-side auth path.
- Admin UI should show a compact provider status summary first, then expandable support details.
- When support-view endpoints are blocked by auth, show a clear admin state such as `Provider support detail unavailable`, plus a direct dashboard link if available.

## Adjacent collections that matter

Other exported collections add important adjacent capabilities:

- PayPal APIs:
  - PayPal shipment tracking endpoints can be used after Merchize provides carrier/tracking data.
  - PayPal transaction search can support reconciliation/backfill when local ledger and PayPal disagree.
  - PayPal capture/refund/dispute endpoints belong to later refund/dispute admin workflows.
- ZeptoMail:
  - Use the existing mailer through a durable outbox. Do not send customer/admin emails as untracked side effects.
- Checkout Recovery:
  - Checkout recovery OTP proves customer email ownership for unresolved paid checkout warnings.
  - It should not mutate Merchize provider state directly.
- Django/backend order endpoints:
  - Django remains the payment-save and `/orders/process/{custom_id}` boundary.
  - Merchize Ops participates in the paid order fulfillment runner after `djangoPaymentSaveCustomId` exists.
  - The process route can satisfy catalog import and push-to-fulfillment only when its response contract confirms those stages.

---

# 3) Relationship To The PayPal TX Ledger

## PayPal TX ledger remains the payment handoff ledger

The PayPal TX ledger should keep enough data to know whether checkout handoff succeeded:

- `orderToken`
- `paypalOrderId`
- `paypalAuthorizationId`
- `djangoOrderIntentUuid`
- `djangoOrderIntentOrderId`
- `djangoPaymentSaveCustomId`
- receipt link and receipt file name
- fulfillment request payload
- Django fulfillment response payload
- extracted Merchize order ID/code summary
- final handoff status

## Merchize Fulfillment Ops becomes the Merchize lifecycle database

The new database should store post-handoff Merchize lifecycle data:

- Merchize lookup snapshots
- Merchize in-depth detail snapshots
- Merchize order rows
- Merchize item rows
- sync attempts
- admin actions
- Merchize tracking events
- Merchize reconciliation notes

## Ledger-to-Merchize Ops field mapping

The PayPal TX ledger remains the source of truth for paid checkout state. Merchize Fulfillment Ops should mirror only the identifiers and snapshots needed to continue the provider lifecycle without replaying payment, receipt, Django payment-save, or Django process side effects.

`PaypalIntent.orderToken` -> `MerchizeFulfillmentOrder.orderToken`

- Purpose: customer support reference, admin URL key, and cross-system correlation.
- Required: yes.

`PaypalIntent.paypalOrderId` -> `MerchizeFulfillmentOrder.paypalOrderId`

- Purpose: PayPal search/escalation context.
- Required: optional.

`PaypalIntent.djangoOrderIntentUuid` -> `MerchizeFulfillmentOrder.djangoOrderIntentUuid`

- Purpose: trace back to the Django OTP/order-intent object.
- Required: optional.

`PaypalIntent.djangoOrderIntentOrderId` -> `MerchizeFulfillmentOrder.djangoOrderIntentOrderId`

- Purpose: trace the Django order-intent order string.
- Current behavior: this is usually the same `ORD-...` value as the Merchize external number.
- Required: yes, when available.

`PaypalIntent.djangoPaymentSaveCustomId` -> `MerchizeFulfillmentOrder.djangoPaymentSaveCustomId`

- Purpose: Django `/orders/process/{custom_id}` path key and Django payment-save correlation.
- Required: yes.

`PaypalIntent.merchizeFulfillmentResponsePayload.data.response_data.data.data.order_id` -> `MerchizeFulfillmentOrder.merchizeExternalOrderNumber`

- Purpose: external number used for Merchize external-number lookup.
- Endpoint: `GET /order/external/orders/order-detail?external_number=...`
- Required: yes.

Merchize external lookup `resp.data._id` -> `MerchizeFulfillmentOrder.merchizeOrderId`

- Purpose: canonical Merchize platform ID for in-depth detail and later provider actions.
- Used for: view, edit, pause, product changes, processing changes, tracking, and status actions.
- Required: yes, after lookup.

`PaypalIntent.merchizeFulfillmentResponsePayload` -> `MerchizeFulfillmentOrder.djangoProcessResponsePayload`

- Purpose: raw Django process response snapshot, including the wrapped Merchize response.
- Required: yes.

Merchize external lookup response -> `MerchizeFulfillmentOrder.merchizeExternalLookupPayload`

- Purpose: provider lookup proof and latest external-number snapshot.
- Required: yes, after lookup.

Merchize in-depth detail response -> `MerchizeFulfillmentOrder.merchizeInDepthOrderDetailPayload`

- Purpose: provider detail proof, item data, shipment/status data, and future admin action context.
- Required: yes, after detail sync.

Rules:

- `MerchizeFulfillmentOrder` must not replace `PaypalIntent`.
- `PaypalIntent` owns payment, receipt, Django save, and Django process completion.
- `MerchizeFulfillmentOrder` owns provider lifecycle after Django accepted the fulfillment process/import and the Next.js runner begins provider push/sync control.
- Use `orderToken` for customer support, URLs, and admin handoff.
- Use `djangoPaymentSaveCustomId` for Django `/orders/process/{custom_id}` correlation.
- Use `merchizeExternalOrderNumber` for Merchize external-number lookup.
- Use `merchizeOrderId` for Merchize platform actions after the external lookup succeeds.
- Do not store only provider IDs. Store the external lookup and in-depth detail snapshots so support can prove what Merchize returned at the time of sync.
- Do not populate `merchizeOrderId` from Django's wrapped process `response_data.data._id`. That value can stay in `djangoProcessResponsePayload`, but the actionable Merchize platform ID must come from external lookup `resp.data._id`.

If Merchize Fulfillment Ops later lives in the same physical database as the PayPal TX ledger, a foreign key to `PaypalIntent` can be added. While the plans keep these as separate schemas/databases, do not fake a database-level FK. Use the correlation keys above.

## Completed semantics

Recommended PayPal ledger meaning:

```txt
status = completed
```

means:

```txt
Payment captured, receipt uploaded, payment saved to Django, and Django/Merchize fulfillment push accepted.
```

It should not mean:

```txt
Merchize has shipped, delivered, or fully synchronized all detail snapshots.
```

Those later states belong to Merchize Fulfillment Ops.

Why:

- The customer should not be held in a scary checkout state because a Merchize detail lookup is delayed.
- Admin/support still gets a durable Merchize lifecycle view in Merchize Fulfillment Ops.
- Merchize sync can be retried independently without replaying payment/receipt/Django save side effects.

---

# 4) Identifier Map

Use names that say which system owns the value.

```txt
orderToken
```

Local PayPal TX ledger support reference. Also mirrored into PayPal custom id where supported.

```txt
paypalOrderId
```

PayPal order ID.

```txt
djangoOrderIntentUuid
```

Django order-intent UUID from the OTP/order-intent flow.

```txt
djangoOrderIntentOrderId
```

Django order-intent order string. This was formerly easy to confuse with an OTP order ID.

```txt
djangoPaymentSaveCustomId
```

Django payment-save custom ID returned by `/orders/order-payment`. Django uses this as the path key for `/orders/process/{custom_id}`.

```txt
merchizeExternalOrderNumber
```

The value sent to Merchize `external_number` lookup. This is confirmed as the provider-facing order string from Django's wrapped Merchize response: `response_data.data.data.order_id`.

In the current checkout flow, this is the `ORD-...` string that also appears as `djangoOrderIntentOrderId` and as the suffix of the wrapped Merchize `identifier`.

Do not confuse this with `djangoPaymentSaveCustomId`. The payment-save custom ID is the Django `/orders/process/{custom_id}` path key, not the primary Merchize external-number lookup value.

```txt
merchizeOrderId
```

Merchize `_id` returned by the external-number lookup response as `resp.data._id`. This is the canonical Merchize platform order ID.

Use it as the path/key value for in-depth detail lookup and later POD actions such as view, edit, pause, change product, change processing, and tracking/status operations.

Do not use the wrapped Django process `response_data.data._id` for this field. Always populate this field from the external-number lookup response.

```txt
merchizeOrderCode
```

Merchize-facing order code or external order string when present.

```txt
merchizeIdentifier
```

The identifier sent through the Django process payload. Current value:

```txt
codexchristi-shop
```

```txt
djangoProcessResponsePayload
```

Raw Django response from `/orders/process/{custom_id}`. This can include a wrapped Merchize response.

```txt
merchizeExternalLookupPayload
```

Raw response from Merchize external-number lookup.

```txt
merchizeInDepthOrderDetailPayload
```

Raw response from Merchize in-depth order detail lookup.

---

# 5) Target Flow

```mermaid
flowchart TD
  A["PayPal webhook/capture"] --> B["PayPal TX ledger"]
  B --> C["Receipt uploaded"]
  C --> D["Django payment saved"]
  D --> E["Django /orders/process/{custom_id}"]
  E --> F{"Catalog import accepted?"}
  F -->|"Yes"| G["Push-to-fulfillment accepted?"]
  F -->|"No"| H["Paid order recovery"]
  G -->|"Yes"| I["PayPal ledger completed"]
  G -->|"No"| H
  I --> J["Merchize Fulfillment Ops upsert"]
  J --> K["Lookup Merchize by external number"]
  K --> L{"Merchize order found?"}
  L -->|"Yes"| M["Fetch in-depth Merchize details"]
  L -->|"No"| N["Admin reconciliation needed"]
  M --> O["Persist Merchize order snapshot"]
  M --> P["Persist Merchize item rows"]
  O --> Q["Admin fulfillment workspace"]
  P --> Q
```

Important boundary:

- The PayPal ledger can complete only after provider push verification; later progress/tracking/invoice/detail refreshes remain synchronous reconciliation work and cannot roll payment backward.
- Merchize Fulfillment Ops can fail/retry without moving the PayPal ledger backward.

---

# 6) Database Strategy

## Recommended DB boundary

Use a separate Prisma schema and datasource for Merchize Fulfillment Ops.

Recommended location:

```txt
prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOps.schema.prisma
```

Recommended client wrapper:

```txt
src/lib/prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOpsPrisma.ts
```

Recommended generated client:

```txt
src/lib/prisma/shop/merchizeFulfillmentOps/generated/merchizeFulfillmentOps
```

Recommended environment variable:

```txt
MERCHIZE_FULFILLMENT_OPS_DATABASE_URL
```

If Neon branches are used:

```txt
MERCHIZE_FULFILLMENT_OPS_NEON_BRANCH=dev
MERCHIZE_FULFILLMENT_OPS_NEON_BRANCH=prod
```

## Why separate DB/schema

Benefits:

- Keeps payment orchestration isolated from Merchize lifecycle complexity.
- Makes admin tooling safer because Merchize sync can be retried independently.
- Keeps high-volume Merchize payload snapshots away from the core payment ledger.
- Allows different retention policies for Merchize payloads and operational audit logs.

Tradeoffs:

- Cross-DB joins are not available directly.
- Admin views must query PayPal ledger and Merchize Fulfillment Ops separately, then merge by `orderToken` or `djangoPaymentSaveCustomId`.
- Transactions cannot atomically update PayPal ledger and Merchize Fulfillment Ops if they live in different physical DBs.

Decision default:

- Accept the tradeoff.
- Use `orderToken` and `djangoPaymentSaveCustomId` as durable correlation keys.
- Treat Merchize Fulfillment Ops sync as eventually consistent.

---

# 7) Proposed Merchize Models

Use Merchize-specific table names for this phase. The current Django process contract, lookup endpoint, duplicate behavior, and item payloads are all Merchize-specific.

## MerchizeFulfillmentOrder

```prisma
model MerchizeFulfillmentOrder {
  id                              String    @id @default(cuid())

  // Correlation with PayPal TX ledger.
  // If this table later moves into the same physical DB as PaypalIntent,
  // add a real FK. In the separate-DB design, keep these as correlation keys.
  orderToken                      String
  paypalOrderId                   String?
  djangoOrderIntentUuid           String?
  djangoOrderIntentOrderId        String?
  djangoPaymentSaveCustomId       String

  // Merchize identity.
  merchizeExternalOrderNumber     String
  merchizeOrderId                 String?
  merchizeOrderCode               String?
  merchizeIdentifier              String?
  merchizeStatus                  String?
  merchizeSubStatus               String?
  merchizeIsEnqueued              Boolean?
  merchizeIsDeleted               Boolean?
  merchizeHidden                  Boolean?

  // Production gate state.
  productionGateStatus            String?
  addressReviewStatus             String?
  costReviewStatus                String?
  progressStatus                  String?
  deliveryStatus                  String?
  releasedToProductionAt          DateTime?
  heldAt                          DateTime?
  lastAddressCheckAt              DateTime?
  lastCostCheckAt                 DateTime?
  lastProgressSyncAt              DateTime?
  lastHistorySyncAt               DateTime?

  // Handoff snapshots.
  djangoProcessResponsePayload    Json?
  merchizeExternalLookupPayload   Json?
  merchizeInDepthOrderDetailPayload Json?
  merchizeAddressSuggestionPayload Json?
  merchizeFulfillmentCostPayload  Json?
  merchizeTransactionFeePayload   Json?
  merchizeProgressPayload         Json?
  merchizeHistoryPayload          Json?

  // Operational state.
  syncStatus                      String
  lastSyncErrorCode               String?
  lastSyncErrorMessage            String?
  lastLookupAt                    DateTime?
  lastDetailSyncAt                DateTime?
  duplicateDetectedAt             DateTime?
  manuallyLinkedAt                DateTime?
  manuallyLinkedBy                String?
  manualLinkReason                String?

  createdAt                       DateTime  @default(now())
  updatedAt                       DateTime  @updatedAt

  @@unique([merchizeExternalOrderNumber])
  @@index([orderToken])
  @@index([djangoPaymentSaveCustomId])
  @@index([merchizeOrderId])
  @@index([merchizeOrderCode])
  @@index([merchizeStatus])
  @@index([syncStatus])
  @@index([productionGateStatus])
  @@index([addressReviewStatus])
  @@index([costReviewStatus])
  @@index([progressStatus])
  @@index([deliveryStatus])
  @@index([updatedAt])
}
```

## MerchizeFulfillmentItem

```prisma
model MerchizeFulfillmentItem {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String

  merchizeLineItemId         String?
  productId                  String?
  merchizeSku                String?
  sellerSku                  String?
  title                      String?
  quantity                   Int
  currency                   String?
  unitPrice                  Decimal?

  // Redacted display helpers can be copied out of payload for admin scanning.
  imageUrl                   String?
  variantSummary             String?

  itemPayload                Json
  createdAt                  DateTime @default(now())
  updatedAt                  DateTime @updatedAt

  @@index([merchizeFulfillmentOrderId])
  @@index([merchizeSku])
  @@index([sellerSku])
  @@index([productId])
}
```

## MerchizeFulfillmentSyncAttempt

```prisma
model MerchizeFulfillmentSyncAttempt {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String?

  orderToken                 String
  action                     String
  status                     String
  errorCode                  String?
  errorMessage               String?
  requestSummary             Json?
  responseSummary            Json?

  startedAt                  DateTime @default(now())
  finishedAt                 DateTime?

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([action])
  @@index([status])
  @@index([startedAt])
}
```

## MerchizeFulfillmentAdminAction

```prisma
model MerchizeFulfillmentAdminAction {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String?

  orderToken                 String
  action                     String
  status                     String
  adminActorId               String?
  adminActorLabel            String?
  reason                     String?
  payload                    Json?
  result                     Json?
  errorMessage               String?

  createdAt                  DateTime @default(now())
  completedAt                DateTime?

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([action])
  @@index([status])
  @@index([createdAt])
}
```

## MerchizeFulfillmentTrackingEvent

```prisma
model MerchizeFulfillmentTrackingEvent {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String

  carrier                    String?
  trackingNumber             String?
  trackingUrl                String?
  status                     String?
  eventPayload               Json
  eventTime                  DateTime?
  createdAt                  DateTime @default(now())

  @@index([merchizeFulfillmentOrderId])
  @@index([trackingNumber])
  @@index([status])
  @@index([eventTime])
}
```

## MerchizeFulfillmentProgressEvent

```prisma
model MerchizeFulfillmentProgressEvent {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String

  orderToken                 String
  merchizeOrderId            String?
  event                      String
  status                     String?
  expectedAt                 DateTime?
  actualAt                   DateTime?
  eventPayload               Json
  syncedAt                   DateTime @default(now())

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([merchizeOrderId])
  @@index([event])
  @@index([status])
  @@index([syncedAt])
}
```

## MerchizeFulfillmentHistoryEvent

```prisma
model MerchizeFulfillmentHistoryEvent {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String

  orderToken                 String
  merchizeOrderId            String?
  event                      String?
  status                     String?
  message                    String?
  historyPayload             Json
  eventTime                  DateTime?
  syncedAt                   DateTime @default(now())

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([merchizeOrderId])
  @@index([event])
  @@index([status])
  @@index([eventTime])
}
```

## MerchizeFulfillmentAddressReview

```prisma
model MerchizeFulfillmentAddressReview {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String

  orderToken                 String
  status                     String
  source                     String
  issueCode                  String?
  issueMessage               String?
  originalAddressSummary     Json?
  suggestedAddressSummary    Json?
  correctedAddressSummary    Json?
  suggestionPayload          Json?
  adminActorId               String?
  adminReason                String?
  customerNotifiedAt         DateTime?
  resolvedAt                 DateTime?
  createdAt                  DateTime @default(now())
  updatedAt                  DateTime @updatedAt

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([status])
  @@index([issueCode])
  @@index([createdAt])
}
```

## MerchizeFulfillmentCostSnapshot

```prisma
model MerchizeFulfillmentCostSnapshot {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String

  orderToken                 String
  snapshotType               String
  status                     String
  currency                   String?
  amount                     Decimal?
  issueCode                  String?
  issueMessage               String?
  payload                    Json
  syncedAt                   DateTime @default(now())

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([snapshotType])
  @@index([status])
  @@index([syncedAt])
}
```

## MerchizeFulfillmentNotificationOutbox

Use this model only if Merchize Fulfillment Ops lives in a separate database from the current PayPal `AdminNotificationOutbox`. The outbox should live beside the state mutation that creates the notification, so a failed email send cannot hide the provider recovery state.

```prisma
model MerchizeFulfillmentNotificationOutbox {
  id                         String   @id @default(cuid())
  merchizeFulfillmentOrderId String?

  orderToken                 String
  type                       String
  issueCode                  String?
  severity                   String   @default("warning")
  status                     String   @default("pending")
  dedupeKey                  String   @unique
  recipient                  String?
  payload                    Json
  attemptCount               Int      @default(0)
  lastAttemptAt              DateTime?
  sentAt                     DateTime?
  suppressedAt               DateTime?
  lastErrorMessage           String?
  createdAt                  DateTime @default(now())
  updatedAt                  DateTime @updatedAt

  @@index([merchizeFulfillmentOrderId])
  @@index([orderToken])
  @@index([type])
  @@index([issueCode])
  @@index([severity])
  @@index([status])
  @@index([createdAt])
}
```

---

# 8) Sync Status Vocabulary

Use string statuses first. Prisma enums can be added later after the vocabulary stabilizes.

```ts
export const MERCHIZE_FULFILLMENT_SYNC_STATUS = {
  SYNC_PENDING: 'sync_pending',
  PROCESS_ACCEPTED: 'process_accepted',
  LOOKUP_PENDING: 'lookup_pending',
  LOOKUP_FAILED: 'lookup_failed',
  LOOKUP_NOT_FOUND: 'lookup_not_found',
  LOOKUP_FOUND: 'lookup_found',
  DETAIL_SYNC_PENDING: 'detail_sync_pending',
  DETAIL_SYNC_FAILED: 'detail_sync_failed',
  DETAIL_SYNCED: 'detail_synced',
  DUPLICATE_DETECTED: 'duplicate_detected',
  DUPLICATE_LINKED: 'duplicate_linked',
  MANUAL_REVIEW: 'manual_review',
  MANUALLY_LINKED: 'manually_linked',
  MERCHIZE_FAILED: 'merchize_failed',
  TRACKING_PENDING: 'tracking_pending',
  TRACKING_SYNCED: 'tracking_synced',
  PRODUCTION_GATE_PENDING: 'production_gate_pending',
  PRODUCTION_GATE_PASSED: 'production_gate_passed',
  PRODUCTION_GATE_BLOCKED: 'production_gate_blocked',
  ADDRESS_REVIEW_REQUIRED: 'address_review_required',
  ADDRESS_CORRECTION_SENT: 'address_correction_sent',
  ADDRESS_CORRECTED: 'address_corrected',
  COST_REVIEW_REQUIRED: 'cost_review_required',
  COST_CHECK_PASSED: 'cost_check_passed',
  PAUSED_FOR_REVIEW: 'paused_for_review',
  RELEASE_READY: 'release_ready',
  RELEASED_TO_PRODUCTION: 'released_to_production',
  PROGRESS_SYNCED: 'progress_synced',
  HISTORY_SYNCED: 'history_synced',
  DELIVERY_EXCEPTION: 'delivery_exception',
} as const;
```

## Status meanings

`sync_pending`

The Merchize Fulfillment Ops row exists, but no Merchize lookup has run yet.

`process_accepted`

Django accepted `/orders/process/{custom_id}`.

`lookup_pending`

Merchize external-number lookup is queued or running.

If Merchize responds with `Order is being processed`, keep this status and persist `MERCHIZE_LOOKUP_PENDING_PROVIDER_PROCESSING`. This is a retryable provider-indexing state, not `lookup_not_found`, until the implementation's bounded retry/grace policy is exhausted.

Current runtime policy:

- Retry the lookup inside the same processing run after short delays of 1.5 seconds and 3 seconds.
- If Merchize still reports provider processing, keep the PayPal ledger scanner-resumable and do not send a critical recovery email.
- Escalate to `MERCHIZE_LOOKUP_NOT_FOUND` after 4 pending provider-processing lookup attempts or after 10 minutes from the first pending provider-processing lookup attempt, whichever comes first.

`lookup_failed`

The Merchize lookup request failed due to transport, auth, rate limit, or Merchize error.

`lookup_not_found`

The lookup succeeded but did not find an order for the expected external number.

`lookup_found`

The Merchize lookup found an order and yielded a Merchize order ID.

`detail_sync_pending`

In-depth Merchize order detail fetch is queued or running.

`detail_sync_failed`

Merchize order detail fetch failed.

`detail_synced`

Merchize order detail and item snapshots were persisted.

`duplicate_detected`

Merchize reported a duplicate condition.

`duplicate_linked`

The duplicate response was successfully linked to an existing Merchize order.

`manual_review`

Admin action is required before the system should continue.

`manually_linked`

Admin manually attached a Merchize order ID or external number.

`merchize_failed`

Merchize says the fulfillment order failed or cannot be processed.

`tracking_pending`

Order detail exists, but tracking sync is not complete.

`tracking_synced`

Tracking details were persisted.

`production_gate_pending`

The order has provider identity/details, but production readiness checks have not finished.

`production_gate_passed`

Address, explicit item/artwork, invoice-envelope, attention, and provider-state checks passed. A
pre-push invoice placeholder is allowed.

`production_gate_blocked`

At least one production readiness check failed or needs manual review.

`address_review_required`

Merchize address suggestion, invalid address, unsupported destination, or ambiguous buyer details require admin/customer review.

`address_correction_sent`

The system notified the customer or admin that address correction is needed.

`address_corrected`

Corrected buyer details were saved locally and pushed to Merchize.

`cost_review_required`

The documented invoice request was rejected, or a later structured accounting snapshot contains an
explicit financial issue requiring admin review.

`cost_check_passed`

The documented invoice request succeeded. This can include a non-blocking pre-push `0`/`null`
placeholder.

`paused_for_review`

The Merchize order is held while admin/customer/provider review is active.

`release_ready`

The order can be opened/released, but the release action has not run yet.

`released_to_production`

The order was opened/released to production.

`progress_synced`

Provider progress/checkpoint data was persisted.

`history_synced`

Provider history data was persisted.

`delivery_exception`

Provider progress/history/tracking suggests shipment or delivery needs support attention.

---

# 9) Merchize API Adapter

The Merchize API code should live behind a small adapter boundary.

Recommended files:

```txt
src/lib/merchizeFulfillmentOps/merchizeClient.ts
src/lib/merchizeFulfillmentOps/merchizeTypes.ts
src/lib/merchizeFulfillmentOps/merchizeMapper.ts
src/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOrder.ts
```

## Client responsibilities

`merchizeClient.ts` should own:

- base URL normalization
- API key header
- safe fetch wrapper
- JSON parsing
- response text capture for failed responses
- timeout handling
- Merchize error classification

## Adapter methods

```ts
export async function getMerchizeOrderByExternalNumber(externalNumber: string) {
  // GET /order/external/orders/order-detail?external_number=...
}

export async function getMerchizeInDepthOrderDetail(merchizeOrderId: string) {
  // GET /bo-api/order/orders/{id}
}

export async function getMerchizeAddressSuggestion(merchizeOrderId: string) {
  // GET /bo-api/order/orders/{id}/address-suggestion
}

export async function updateMerchizeBuyerDetails(merchizeOrderId: string, payload: unknown) {
  // POST /bo-api/order/orders/{id}/buyerdetails
}

export async function getMerchizeExternalOrderInvoice(
  reference: MerchizeExternalOrderReference,
) {
  // GET /order/external/orders/order-invoice?external_number=...&identifier=...
}

export async function getMerchizeTransactionFee(merchizeOrderId: string) {
  // GET /bo-api/order/orders/{id}/transaction-fee
}

export async function getMerchizeOrderHistory(merchizeOrderId: string) {
  // GET /bo-api/order/orders/{id}/histories
}

export async function getMerchizeOrderProgress(merchizeOrderId: string) {
  // GET /bo-api/order/get-order-progress/{id}
}

export async function holdMerchizeOrderForReview(merchizeOrderId: string) {
  // PATCH /bo-api/order/update-order-status/{id}
}

export async function openMerchizeOrderForProduction(merchizeOrderId: string) {
  // PATCH /bo-api/order/update-order-status/{id}
}
```

## Deferred dashboard/support-view adapter methods

These come from the HAR-derived order support collection. They should be added only after the auth requirement is confirmed and the server has a stable credential that is safe to store outside the browser.

```ts
export async function getMerchizeSendToFulfillmentDate(merchizeOrderId: string) {}
export async function getMerchizeUnfulfilledItems(merchizeOrderId: string) {}
export async function getMerchizeFulfillmentInvoice(merchizeOrderId: string) {}
export async function getMerchizeIossDisplay(merchizeOrderId: string) {}
export async function getMerchizeBuyerDetails(merchizeOrderId: string) {}
export async function getMerchizeBuyerDetailsDisplayStatus(merchizeOrderId: string) {}
export async function getMerchizeRequireAttention(merchizeOrderId: string) {}
export async function getMerchizeOrderTags(merchizeOrderId: string) {}
export async function getMerchizeOrderNotes(merchizeOrderId: string) {}
```

Rules:

- Treat these as support snapshots, not payment truth.
- Store raw responses behind admin-only access.
- Use normalized summaries for list views, notification emails, and customer-facing messages.
- Do not implement these against a human browser session.
- `x-store-id` alone is not enough if the endpoint also expects `x-refresh-token`.
- If Merchize provides an API-key equivalent for these support views, move the specific endpoint from deferred to the active adapter list.
- If no server credential exists, keep the admin UI action as a dashboard handoff rather than a broken or insecure automatic sync.

## Required environment variables

Names should be confirmed before implementation, but the shape should be:

```txt
MERCHIZE_BO_API_BASE_URL=https://bo-group-2-2.merchize.com/27mkjsl/bo-api
MERCHIZE_API_KEY=...
MERCHIZE_STORE_ID=...
```

If the order-management endpoints require a different token or header from storefront/catalog endpoints:

```txt
MERCHIZE_ACCESS_TOKEN=...
```

If Merchize later grants an official server-safe dashboard/support credential:

```txt
MERCHIZE_SUPPORT_VIEW_REFRESH_TOKEN=...
```

Do not add `MERCHIZE_SUPPORT_VIEW_REFRESH_TOKEN` until the source and rotation model are understood.

Rules:

- Server-only.
- Never expose through `NEXT_PUBLIC_*`.
- Never log the token.
- `MERCHIZE_STORE_ID` is store context, not a secret, but it should still stay server-side unless a client-side route explicitly needs a non-sensitive store label.
- Dashboard refresh/session credentials must have a rotation plan before production use.
- Never include token values in guide files, screenshots, or admin views.

---

# 10) Paid Order Fulfillment Processing Integration Point

The integration point is the paid order fulfillment runner:

```txt
runPaidFulfillmentProcessing(orderToken)
```

The old `runPostProcessing(orderToken)` name should not stay as an alias-only fallback. `runPaidFulfillmentProcessing(orderToken)` is the canonical parent orchestration entrypoint and should call clearly named internal stages.

The target stage sequence:

1. PayPal capture payload exists.
2. Receipt upload is ensured.
3. Django payment save is ensured.
4. Merchize catalog fulfillment payload is built and validated.
5. Catalog-backed order creation/import is accepted.
6. Production readiness passes.
7. Push-to-fulfillment is acknowledged.
8. Provider state verifies that the order is pushed.
9. The PayPal TX ledger can set `status = completed` for the paid checkout fulfillment runner.
10. Progress, tracking, invoice, ticket, and health reconciliation continue synchronously on schedule.

Completion rule:

- `completed` means payment captured, receipt uploaded, Django payment saved, and provider push verified.
- It does not require in-depth detail snapshots, tracking availability, shipment, delivery, or every operational check to be fresh.
- Accepted Django `/orders/process/{custom_id}` responses satisfy stage 5. The current Next.js runtime runs readiness, calls the server-only Merchize push adapter, and verifies provider state.
- Do not replay PayPal capture, receipt upload, Django payment save, or the Django process path for accepted 201 rows; resume at Merchize Ops registration, lookup, and push.

Recommended function boundary:

```txt
src/lib/paypal/txLedger/runPaidFulfillmentProcessing.ts
src/lib/merchizeFulfillmentOps/registerAcceptedMerchizeFulfillmentProcess.ts
src/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOrder.ts
src/lib/merchizeFulfillmentOps/pushMerchizeFulfillmentOrderToProduction.ts
src/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOperationalSnapshots.ts
```

Suggested signature:

```ts
type MerchizeFulfillmentRegistrationInput = {
  orderToken: string;
  paypalOrderId: string | null;
  djangoOrderIntentUuid: string | null;
  djangoOrderIntentOrderId: string | null;
  djangoPaymentSaveCustomId: string;
  fulfillmentIdentifier: string;
  merchizeExternalOrderNumber: string;
  // Usually null during registration. Populate from external lookup resp.data._id.
  merchizeOrderId: string | null;
  merchizeOrderCode: string | null;
  merchizeStatus: string | null;
  djangoProcessResponsePayload: unknown;
};
```

Important rule:

- Failure to register/sync Merchize Fulfillment Ops should not replay PayPal capture, receipt upload, Django payment save, or an accepted Django process response.
- Failure to sync post-push operational snapshots should not undo a push-to-fulfillment-accepted checkout.
- If registration or external lookup fails before push, keep the row unresolved and alert the fulfillment group.
- If push-to-fulfillment fails, keep the order unresolved and alert the fulfillment group. Do not mark the paid order fulfillment runner complete.

---

# 11) Admin Hub Actions

Merchize Fulfillment Ops admin actions should be available under the broader admin shop area.

Recommended route family:

```txt
/admin/shop/merchize-fulfillment-ops
/admin/shop/merchize-fulfillment-ops/[orderToken]
```

## List page

The list page should support:

- search by support ref / `orderToken`
- search by customer email via PayPal ledger join/search
- search by `djangoPaymentSaveCustomId`
- search by Merchize order ID
- filter by sync status
- filter by Merchize status
- filter by duplicate/reconciliation state
- filter by last sync error
- sort by updated time
- compact row cards on mobile
- wider table rows on desktop

## Detail page

The detail page should show:

- PayPal ledger summary
- Django payment-save custom ID
- Merchize external order number
- Merchize order ID
- Merchize order code
- Merchize status
- sync status
- last sync error
- Merchize item rows
- checkout cart snapshot comparison
- fulfillment address summary
- Merchize shipping info summary with PII redaction controls
- raw Merchize payload modal behind admin confirmation
- sync attempt history
- admin action history
- notification history

## Actions

Initial actions:

- Refresh external-number lookup.
- Refresh in-depth Merchize details.
- Run production readiness checks.
- Refresh address suggestion.
- Refresh fulfillment invoice / transaction fee.
- Refresh progress.
- Refresh history.
- Retry failed Merchize Fulfillment Ops sync.
- Link duplicate Merchize order.
- Manually attach Merchize order ID.
- Compare checkout cart to Merchize item rows.
- Copy safe support reference.
- Open related PayPal TX ledger detail.

Future actions:

- Sync tracking.
- Hold order for review.
- Open/release order to production.
- Save corrected buyer details.
- Change product.
- Change processing.
- Cancel Merchize order.
- Escalate to Merchize support.
- Mark manually reconciled.
- Send customer update.
- Add internal note.

## Dangerous actions

These should require stronger admin confirmation and eventually WebAuthn/passkey step-up:

- Manually attach Merchize order ID.
- Open/release order to production.
- Hold order after it was already release-ready.
- Save corrected buyer details.
- Change product.
- Change processing.
- Cancel Merchize order.
- Mark manually reconciled.
- Send customer-facing update.
- Override Merchize shipping address.

---

# 12) Duplicate Order Reconciliation

Duplicate Merchize responses are not all equal.

## Benign duplicate

A benign duplicate means:

- Merchize already accepted the order.
- The external number maps to an existing Merchize order.
- Merchize lookup by external number succeeds.
- The found Merchize order matches expected cart/customer/address sufficiently.

Action:

- Set `syncStatus = duplicate_linked`.
- Persist lookup/detail payloads.
- Add admin action history entry.
- Do not retry order creation.

## Suspicious duplicate

A suspicious duplicate means:

- Merchize reports duplicate.
- External-number lookup fails.
- Or lookup returns an order whose item/address/customer summary does not match expected ledger data.

Action:

- Set `syncStatus = manual_review`.
- Show comparison differences in admin.
- Prevent automatic create/retry loops.
- Allow admin to manually link or escalate.

## Duplicate flow

```mermaid
flowchart TD
  A["Merchize duplicate response"] --> B["Lookup by external number"]
  B --> C{"Found Merchize order?"}
  C -->|"No"| D["manual_review"]
  C -->|"Yes"| E["Fetch in-depth detail"]
  E --> F{"Matches expected order?"}
  F -->|"Yes"| G["duplicate_linked"]
  F -->|"No"| H["manual_review"]
```

---

# 13) Cart And Merchize Item Comparison

The admin detail should compare:

- expected items from the PayPal TX ledger canonical order snapshot for P0.2 rows; use
  `cartSnapshot` only for an all-null pre-P0.2 legacy envelope
- request items sent to Django process
- Merchize items returned by Merchize lookup/detail

Comparison fields:

- product ID
- Merchize SKU
- seller SKU
- title/name
- variant attributes
- quantity
- unit price
- currency
- image URL presence

Possible comparison states:

```txt
match
quantity_mismatch
sku_mismatch
missing_merchize_item
extra_merchize_item
price_mismatch
currency_mismatch
needs_manual_review
```

Admin UI should show a compact summary first:

```txt
Items match: 2/2
Warnings: none
```

Then allow expanding into item-level details.

---

# 14) Merchize Detail Sync Worker

The first implementation can run sync synchronously after registration or through admin actions. The eventual implementation should support a small job/retry pattern.

Recommended helper:

```txt
src/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOrder.ts
```

Suggested logic:

```ts
export async function syncMerchizeFulfillmentOrder(orderToken: string) {
  const order = await merchizeFulfillmentOpsPrisma.merchizeFulfillmentOrder.findFirst({
    where: { orderToken },
  });

  if (!order) throw new Error('Merchize Fulfillment Ops order not found');

  await recordSyncAttempt({ action: 'external_lookup', status: 'running' });

  const lookup = await merchizeClient.getMerchizeOrderByExternalNumber(
    order.merchizeExternalOrderNumber,
  );

  const merchizeOrderId = extractMerchizeOrderId(lookup);

  if (!merchizeOrderId) {
    if (lookup.message === 'Order is being processed') {
      await markLookupPendingForRetry(...);
      return;
    }

    await markLookupNotFoundOrManualReview(...);
    return;
  }

  await recordSyncAttempt({ action: 'detail_lookup', status: 'running' });

  const detail = await merchizeClient.getMerchizeInDepthOrderDetail(merchizeOrderId);

  await persistMerchizeOrderAndItems({ lookup, detail });
}
```

Retry rules:

- Retrying sync must not call PayPal.
- Retrying sync must not call Django payment save.
- Retrying sync must not recreate the Merchize order.
- Retrying sync may call Merchize lookup/detail endpoints.
- Retrying sync may update Merchize status and item snapshots.
- A pending provider-indexing retry must not send a critical admin email or surface a customer-facing failure.

## Production readiness worker extension

After lookup and in-depth detail sync succeed, a second worker should decide whether the order can safely move toward production.

Recommended helper:

```txt
src/lib/merchizeFulfillmentOps/runMerchizeProductionReadinessChecks.ts
```

Suggested flow:

```mermaid
flowchart TD
  A["Detail synced"] --> B["Compare expected cart/items"]
  B --> C["Check address suggestion"]
  C --> D["Fetch documented invoice statistics"]
  D --> E["Check explicit attention and order state"]
  E --> F["Sync progress/history support signals"]
  F --> G{"All checks safe?"}
  G -->|"yes"| H["release_ready"]
  G -->|"no"| I["production_gate_blocked"]
  I --> J["Create admin notification"]
  I --> K{"Customer action needed?"}
  K -->|"yes"| L["Send customer-safe address/update email"]
  K -->|"no"| M["Admin review only"]
```

Automatic release/open should be conservative. The worker may mark `release_ready`, but actually opening the order can either:

- run automatically only after all configured safety checks pass, or
- stay as an explicit admin action during beta.

For beta, prefer explicit admin release until the provider behavior is observed across enough real orders.

## Production readiness decision matrix

Auto-pass only when all of these are true:

- External-number lookup succeeded.
- `merchizeOrderId` is present from external lookup `resp.data._id`.
- In-depth detail lookup succeeded.
- Cart/request/detail item comparison is acceptable.
- Address suggestion endpoint returns no blocking issue.
- Buyer detail display/status endpoint does not require review.
- The documented invoice endpoint does not return `success: false`; `0`/`null` cost is allowed
  before push.
- Require-attention endpoint has no blocking issue.
- Order is not cancelled, failed, deleted, or otherwise provider-blocked.

Block production when any of these occur:

- External-number lookup fails or returns a different order.
- In-depth detail lookup fails.
- Item count, SKU, product, currency, or quantity mismatch needs review.
- Address suggestion exists and needs admin/customer choice.
- Country/postal-code change may change cost.
- The documented invoice request is rejected (`success: false`) and must be retried.
- Direct item/resolved-variant evidence reports an unavailable or unmapped product.
- Require-attention, tags, notes, or histories indicate provider support is needed.
- Progress stays in a non-moving state longer than the configured threshold.

## Address review and customer notification flow

Address issues should be handled as a first-class workflow, not an ad hoc admin edit.

Recommended flow:

```txt
address suggestion found
-> create MerchizeFulfillmentAddressReview
-> set addressReviewStatus = review_required
-> hold order if needed
-> notify admin
-> optionally notify customer with safe correction request
-> save corrected address locally
-> if Django import was accepted but Fulfillment Ops identity is missing:
   register the accepted external number and resolve merchizeOrderId from lookup data._id
-> POST /order/orders/{merchizeOrderId}/buyerdetails
-> GET /order/orders/{merchizeOrderId}/buyerdetails
-> compare line1, line2, city, state, postal code, and ISO-2 country code
-> rerun address suggestion
-> rerun cost/fee checks
-> mark providerAddressUpdatedAt only after provider read-back confirms the edit
```

Local-only behavior is valid only before Django has accepted the catalog-backed import. Once the
accepted `200`/`201` process contract exists, a missing Fulfillment Ops row is recoverable
correlation debt: registration and canonical external-number lookup must run before mutation. If
lookup is pending or fails, preserve the local correction but show a provider-not-updated failure.
Never report that case as an initial-import success.

The correction path must read live detail/send-to-fulfillment evidence before mutation. If Merchize
already reports `pushed`, fail closed and require provider intervention. A successful mutation is
verified with one immediate buyer-details GET and at most one short-backoff retry; logs and admin
actions store only verification status and mismatched semantic field names, never address values.

Customer email rules:

- Send customer email only when customer action is useful.
- Do not include raw provider payloads.
- Include support reference, safe order summary, and a clear correction request.
- Do not promise release/shipping until cost and production checks pass.

Admin email rules:

- Include issue type, support reference, provider order ID if available, and admin detail link.
- Include redacted address summary only when needed.
- Use deterministic dedupe keys so repeated sync attempts do not spam admins.

## Cost, invoice, and fee review flow

Invoice checks capture current provider accounting evidence without inventing production blockers
from a pre-push placeholder.

Recommended flow:

```txt
detail synced
-> GET /order/external/orders/order-invoice?external_number=...&identifier=...
-> GET transaction-fee
-> optionally GET fulfillment-invoice / IOSS display
-> persist MerchizeFulfillmentCostSnapshot rows
-> classify structured cost as available/paid, or 0/null as awaiting fulfillment
-> refresh invoice after push and reconcile later lifecycle changes
```

Rules:

- If the documented invoice envelope has `success: false`, set
  `costReviewStatus = provider_error` and retry synchronization.
- Do not parse an invoice message into address, mapping, or artwork status.
- Do not require a generated invoice before push; live `0`/`null` values are expected placeholders.
- If a corrected address changes country, postal code, or shipping zone, rerun all cost checks.
- Do not automatically charge extra, refund, or alter PayPal state from Merchize Ops.
- Escalate payment/refund changes to the later PayPal post-sale ops workflow.

## Progress, history, and delivery state flow

Progress/history sync should run after provider identity exists and then periodically or from admin refresh.

Recommended flow:

```txt
GET /order/orders/{merchizeOrderId}/histories
GET /order/get-order-progress/{merchizeOrderId}
GET support views when needed
-> persist progress/history events
-> update deliveryStatus/progressStatus
-> notify admin/customer only on meaningful state changes
```

Customer-safe status examples:

- order received by fulfillment provider
- production review needed
- production started
- shipped/tracking available
- delivery issue under review

Admin-only status examples:

- provider require-attention flag
- unfulfilled item mismatch
- buyer detail display problem
- fulfillment invoice failure
- provider tag/note requiring review
- stuck progress checkpoint

## PayPal post-fulfillment handoff

The PayPal API collection has tracking, transaction search, refund, and dispute endpoints. These should not be mixed into the first Merchize Ops schema, but Merchize Ops must capture the fields that make those later workflows possible.

Fields to preserve for later PayPal post-sale ops:

- `orderToken`
- `paypalOrderId`
- PayPal capture ID from the TX ledger capture payload
- `merchizeOrderId`
- `merchizeExternalOrderNumber`
- carrier/tracking number/tracking URL when available
- shipped/delivered timestamps when available

Later PayPal ops can use:

- PayPal shipment tracking APIs after Merchize tracking exists.
- PayPal transaction search for reconciliation.
- PayPal refund APIs for approved refund flows.
- PayPal dispute APIs for evidence/support workflows.

---

# 15) Admin Notification Integration

Merchize Fulfillment Ops should use the existing admin notification idea, but avoid spamming.

Notification triggers:

- Merchize lookup failed repeatedly
- Merchize detail sync failed repeatedly
- suspicious duplicate
- Merchize item mismatch
- Merchize status failed
- production gate blocked
- address review required
- buyer detail update failed
- fulfillment invoice/cost check failed
- transaction fee check failed or unpaid
- require-attention/support-view flag detected
- progress checkpoint stuck
- delivery exception detected
- tracking sync failed after shipment should exist

Notification dedupe keys:

```txt
merchize-fulfillment-ops:{orderToken}:{issueType}
```

Email body should include:

- support ref
- Merchize
- sync status
- issue type
- safe Merchize ID if available
- admin detail link
- concise issue list
- last safe automatic action taken

Email body should not include:

- full address
- full raw Merchize JSON
- payment token details
- API keys

Customer-facing email triggers:

- address correction needed
- order delayed but payment was received
- production review needed
- shipped/tracking available
- delivery exception that support is actively handling

Customer-facing email should not be sent for every internal sync failure. Prefer admin-only notifications unless the customer can take a useful action or needs a clear expectation update.

---

# 16) Security And Auth

Merchize Fulfillment Ops is admin-only.

Rules:

- No public unauthenticated route should expose Merchize payloads.
- No Merchize API keys in client bundles.
- No `NEXT_PUBLIC_*` Merchize secrets.
- Raw payload modal should require admin auth and eventually step-up auth.
- Dangerous actions should require reason text.
- Admin action history should record actor identity when central auth exists.
- Do not rely on browser local storage for admin auth.

Production target:

- WebAuthn/passkeys plus opaque server-side admin sessions, as described in the admin recovery tooling guide.

---

# 17) PII Redaction Rules

## Logs

Logs can include:

- `orderToken`
- Merchize
- sync status
- Merchize order ID
- action name
- error class

Logs should not include:

- full Merchize payload
- full address
- full email
- phone number
- API token

## Admin UI

Admin UI can show PII only where operationally necessary.

Default view:

- redacted email
- city/state/country summary
- item summaries
- support ref

Expanded secured view:

- full shipping address
- raw payload

The expanded view should be intentional, audited, and eventually step-up protected.

## Markdown/PDF guides

Never paste real PII examples into guides. Use redacted fixtures only.

---

# 18) Implementation Order

## Phase 0 - Finish current ledger boundary

Before starting Merchize Fulfillment Ops DB implementation:

1. Use `merchizeExternalOrderNumber = response_data.data.data.order_id` from the wrapped Django process response, with `djangoOrderIntentOrderId` as the semantic local equivalent in the current flow.
2. Runtime-test Django `201 + success true + processing_status completed + informational error_message`.
3. Confirm PayPal ledger `completed` semantics.
4. Backfill or manually repair rows that were incorrectly marked `fulfillment_failed` because of the known informational message.
5. Remove or confirm the unused fulfillment `phone` field in the Django process payload.
6. Commit the current fulfillment classifier and docs changes.

## Phase 1 - Schema and client

1. Create `prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOps.schema.prisma`.
2. Add Merchize-specific models.
3. Add Prisma scripts for dev/prod generate and migrate.
4. Add `merchizeFulfillmentOpsPrisma` server-only wrapper.
5. Generate the client.
6. Run migration on dev.

## Phase 2 - Merchize adapter

1. Add server-only Merchize client.
2. Implement external-number lookup.
3. Implement in-depth order detail lookup.
4. Add error classification.
5. Add redaction helpers.
6. Add tests or scripts with redacted fixtures.

## Phase 3 - Registration after accepted process

1. Add `registerAcceptedMerchizeFulfillmentProcess(...)`.
2. Call it after Django process response is accepted.
3. Upsert Merchize Fulfillment Ops order by external number.
4. Save Django process response payload.
5. Extract `merchizeExternalOrderNumber` from `response_data.data.data.order_id`.
6. Leave `merchizeOrderId` empty unless a prior external-number lookup has already supplied `resp.data._id`.
7. Do not copy Django's wrapped process `response_data.data._id` into `merchizeOrderId`.
8. Optionally store Django's wrapped process `_id` only inside `djangoProcessResponsePayload` or a clearly named non-actionable diagnostic field.
9. Extract provider status/code summaries only when their meaning is clear.
10. Do not fail PayPal post-processing if registration fails; record the issue for admin recovery.

## Phase 4 - Sync

1. Add `syncMerchizeFulfillmentOrder(...)`.
2. Lookup by `merchizeExternalOrderNumber`.
3. Store the external lookup response as `merchizeExternalLookupPayload`.
4. Extract `merchizeOrderId` from external lookup `resp.data._id`.
5. Fetch in-depth detail by `merchizeOrderId`.
6. Store the in-depth response as `merchizeInDepthOrderDetailPayload`.
7. Persist normalized order snapshot fields.
8. Persist normalized item rows.
9. Record sync attempts.
10. Handle duplicate flow.

## Phase 5 - Admin UI

1. Add Merchize Fulfillment Ops card to `/admin/shop`.
2. Add list page.
3. Add detail page.
4. Add refresh lookup action.
5. Add refresh detail action.
6. Add duplicate-link action.
7. Add manual-link action.
8. Add item comparison section.
9. Add raw payload modal.
10. Add sync/admin action timeline.

## Phase 6 - Production readiness checks

1. Add `runMerchizeProductionReadinessChecks(...)`.
2. Compare cart/request/detail item snapshots.
3. Fetch address suggestion.
4. Fetch documented external-order invoice statistics by `external_number + identifier`.
5. Treat pre-push `fulfillment_cost: 0`/`null` as non-blocking awaiting-fulfillment evidence.
6. Keep transaction-fee retrieval as supplemental diagnostics rather than a release gate.
7. Fetch require-attention/support-view signals only when a stable server-side auth path exists.
8. Persist address/invoice/progress snapshots.
9. Set `productionGateStatus`.
10. Create admin notifications for blockers.
11. Keep beta release/open as an explicit admin action unless all safety checks are proven stable.

## Phase 7 - Address review and buyer detail correction

1. Add `MerchizeFulfillmentAddressReview`.
2. Add address suggestion refresh action.
3. Add customer-safe address correction email template.
4. **Implemented:** admin address correction form with required reason.
5. **Implemented:** save the corrected address locally and regenerate the stable receipt.
6. **Implemented:** backfill missing accepted-order correlation, call
   `updateMerchizeBuyerDetails(...)`, and verify persistence by reading buyer details back.
7. **Implemented:** rerun the bounded production-readiness checks after verified provider mutation.
8. Remaining: dedicated address-review rows and customer correction-request messaging.
9. Remaining: normalize richer cost-delta evidence when a correction changes fulfillment cost.

## Phase 8 - Production hold/open controls

1. Add hold/open adapter methods.
2. Add admin hold action.
3. Add admin open/release action.
4. Require admin reason.
5. Require step-up auth in production phase.
6. Block open/release when `productionGateStatus = production_gate_blocked`.
7. Persist admin action history.

## Phase 9 - Progress, history, and delivery sync

1. Add progress event persistence.
2. Add history event persistence.
3. Add support-view snapshots for unfulfilled items, tags, notes, require-attention, buyer display status, IOSS, and fulfillment invoice only after the required Merchize auth profile is confirmed.
4. Add periodic/manual refresh action.
5. Derive customer-safe delivery status.
6. Create admin notifications for stuck or exception states.
7. Prepare PayPal shipment tracking sync after Merchize tracking fields are understood.

## Phase 10 - PayPal post-sale and support handoff

1. Preserve PayPal capture IDs from the TX ledger for later refund/dispute workflows.
2. Preserve tracking identifiers for PayPal shipment tracking APIs.
3. Add a future PayPal post-sale ops guide or section for refunds, transaction search, and disputes.
4. Keep refunds/disputes outside Merchize Ops until central admin auth/audit is ready.

---

# 19) Testing Matrix

## Contract tests

- Accepted Django `201` with informational message becomes accepted.
- Django `success: false` becomes failure.
- Unknown `processing_status: failed` becomes failure unless explicitly idempotent.
- Merchize duplicate response triggers lookup/reconciliation.

## Sync tests

- External-number lookup finds Merchize order.
- External-number lookup returns no order.
- External-number lookup fails due to Merchize error.
- Detail lookup succeeds.
- Detail lookup fails.
- Detail lookup returns malformed payload.

## Admin tests

- List filters by sync status.
- Detail page shows Merchize summary.
- Raw payload is hidden by default.
- Refresh lookup records sync attempt.
- Refresh detail records sync attempt.
- Duplicate link requires reason.
- Manual link requires reason.

## PII tests

- Logs do not include full address.
- Notification body does not include raw Merchize JSON.
- Guide fixtures are redacted.
- Admin default rows show redacted summaries only.

---

# 20) Resolved Scope Decisions

These decisions supersede the older open-question framing.

1. The semantic runner is `runPaidFulfillmentProcessing(orderToken)`. The older `runPostProcessing(orderToken)` entrypoint should stay out of call sites and must not return as an alias-only fallback.

2. Provider-confirmed `pushed` state is the paid-order fulfillment completion boundary; HTTP command acknowledgment is intermediate.

3. Django `/orders/process/{custom_id}` satisfies catalog-backed process acceptance. Even if Django later issues push directly, provider state must still be verified.

4. Current runtime should treat Django process acceptance as catalog-backed process acceptance, then call `POST /order/external/orders/push` explicitly before completion.

5. Provider detail sync, progress sync, tracking sync, invoice/cost sync, and issue checks can run after completion as idempotent stages, but they remain part of the fulfillment ops domain.

6. Admin must be able to run the remaining pipeline and individual stage actions.

7. Internal alerts should use the Admin Ops ledger as the home for reusable alert routing, recipient groups, and outbox state.

8. Alert emails should use redacted payloads by default and link to protected admin detail pages for full data.

9. Raw Merchize payload retention, dashboard-session-only endpoints, and dangerous provider mutations still need provider-auth and retention decisions before production automation.

---

# 21) Decision Defaults

Unless explicitly changed:

- Use Merchize-specific table names.
- Keep PayPal TX ledger as the payment handoff source of truth.
- Use `fulfillmentIdentifier` in local code and map it to Merchize's `identifier` field at adapter boundaries.
- Treat `POST /order/external/orders/catalog` as catalog import, not final fulfillment success.
- Treat `POST /order/external/orders/push` as command acknowledgment, not completion.
- Mark paid order fulfillment complete only after provider push verification.
- Let detail snapshots, tracking, and issue checks be retried independently after completion.
- Do not show final customer fulfillment success until the in-depth/send-state verification confirms provider release; later lifecycle snapshots remain non-blocking.
- Do not replay Merchize order creation during duplicate reconciliation.
- Require admin reason for manual linking and dangerous actions.
- Redact PII by default.
- Keep raw Merchize payload access admin-only.

---

# 22) Implementation Steps

1. Update documentation and names around paid order fulfillment processing.
2. Keep `runPaidFulfillmentProcessing(orderToken)` as the semantic paid-order fulfillment runner. Do not add a second parallel orchestrator.
3. Extract stage helpers for receipt upload, Django payment save, fulfillment payload validation, catalog import/process, push-to-fulfillment, provider lookup, attention checks, address review, availability checks, tracking sync, and reconciliation.
4. Add or adapt server-only Merchize adapter methods for:
   - `POST /order/external/orders/catalog`
   - `POST /order/external/orders/push`
   - `GET /order/external/orders/order-detail`
   - `GET /order/external/orders/order-progress`
   - `GET /order/external/orders/tracking`
   - `GET /order/external/orders/order-invoice`
   - `POST /order/external/orders/list-orders-detail`
   - `POST /order/external/orders/list-orders-tracking`
   - `POST /order/external/orders/list-orders-invoice`
   - `POST /order/external/orders/update-order-status`
   - `POST /order/external/orders/cancel`
5. Persist `fulfillmentIdentifier`, `merchizeExternalOrderNumber`, push attempt summaries, lookup snapshots, normalized order snapshots, item snapshots, progress snapshots, tracking snapshots, and invoice/cost snapshots.
6. Use explicit states for `push_to_fulfillment_pending`, `push_to_fulfillment_acknowledged`, `push_to_fulfillment_verification_pending`, `push_to_fulfillment_verified`, readiness blockers, tracking sync, and reconciliation.
7. Add Admin Ops ledger internal alert routing before wiring new alert events.
8. Replace fulfillment-specific notification calls with reusable internal alert enqueue/send helpers.
9. Add admin actions to run the remaining pipeline and to run individual stages.
10. Maintain tests for accepted 201 handling, push acknowledgment versus verification, retry guards, readiness classification, redaction, alert dedupe, and admin stage actions.
