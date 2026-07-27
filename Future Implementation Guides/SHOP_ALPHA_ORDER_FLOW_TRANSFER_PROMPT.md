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
- No arbitrary small SKU allowlist. Any offered variant can sell only when server product, mapping,
  price, destination, and shipping checks pass.
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
- Worldwide means provider-supported destinations only. Unsupported or tax-blocked destinations
  stop before payment.
- Refunds, disputes, automated cancellation, arbitrary product/artwork mutations, and full provider
  dashboard parity are out of scope.

## Current verified gaps

- PayPal creation still has client-derived cart/price trust.
- the local provider-country dataset is stale;
- missing SKU shipping can use an unsafe flat fallback;
- missing `MERCHIZE_FULFILLMENT_PUSH_ENABLED` currently enables push instead of failing closed;
- raw `orderToken` possession can read confirmation status;
- only the preparing customer email is implemented;
- most footer policy links are placeholders;
- cron heartbeat/global pending-outbox dispatch are incomplete;
- lifecycle provider reads are too request-heavy.

## Required first implementation order

1. Preserve ordinary signup/OTP/login behavior and keep the signup and shop-home alpha notices
   informational only. This item does not require persistence and must not grow into a participation
   subsystem.
2. Build one immutable canonical server order snapshot and use it for PayPal, capture
   reconciliation, receipt, and fulfillment comparison.
3. Enforce current destination/SKU/shipping/tax eligibility before payment.
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

## How to begin

1. Run `git status --short` and inspect recent commits.
2. Re-scan the current implementations before editing because other agents may have changed files.
3. Compare the code against the release guide's "Current Codebase Checkpoint."
4. Propose the smallest P0 slice that can be implemented and tested end to end.
5. Before editing, state the exact files and behavior being changed.
6. Use existing patterns, preserve unrelated dirty changes, add risk-proportionate tests, and verify
   migrations against both dev and production branches when schema changes are involved.

Do not broaden scope into refunds, disputes, product changes, cancellation automation, or full
Merchize dashboard parity without asking.
