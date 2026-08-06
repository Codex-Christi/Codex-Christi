# PayPal Webhook Registration And Recovery Guide

Last updated: 2026-08-06

This guide documents the current PayPal webhook and post-payment recovery state in the repository, then defines the safe implementation path for webhook registration, sandbox/live payment-mode separation, and recovery behavior.

Related source docs:

- `SHOP_ALPHA_ORDER_FLOW_RELEASE_GUIDE.md`
- `PAYPAL_TX_LEDGER_GUIDE.md`
- `ADMIN_RECOVERY_TOOLING_GUIDE.md`
- `MERCHIZE_FULFILLMENT_OPS_GUIDE.md`

Release sequencing:

- `SHOP_ALPHA_ORDER_FLOW_RELEASE_GUIDE.md` is canonical for public-alpha priority.
- This guide covers PayPal webhooks. Its guidance must not be confused with the P1 Merchize webhook
  plan in the alpha release guide.
- The accepted alpha trigger policy keeps the explicitly enabled capture-route continuation as the
  fast path, the recovery scanner as the durable fallback, PayPal webhooks as a payment-event safety
  net, and the confirmation status route read-only.

## Current Repository State

The repository currently has a ledger-backed PayPal flow, but post-payment processing is not triggered only by the webhook.

The current post-payment runner is:

```txt
src/lib/paypal/txLedger/runPaidFulfillmentProcessing.ts
```

Target semantic name:

```txt
src/lib/paypal/txLedger/runPaidFulfillmentProcessing.ts
```

Do not keep `runPostProcessing(orderToken)` as an alias-only fallback. Trigger callers should use `runPaidFulfillmentProcessing(orderToken)`, the real parent orchestrator that executes the paid order fulfillment stages.

That runner performs these follow-up steps after PayPal capture already exists:

1. Generate and upload the receipt.
2. Save payment details to the Django backend.
3. Build/validate the catalog-backed fulfillment payload.
4. Create/import the Merchize catalog order through Django or a server-only adapter.
5. Push the order to fulfillment.
6. Persist request/response payloads, provider identifiers, issue state, and final ledger status.

It does not authorize or capture PayPal money. Authorization and capture happen earlier in the PayPal approval/capture flow.

Before any follow-up side effect, P0.2 requires the shared full payment chain: the persisted PayPal
authorization and completed capture must each match the sealed canonical total/currency. Webhook,
capture recovery, payment reconciliation, scanners, the runner, receipt regeneration, and mutating
admin recovery cannot bypass this gate. Only a row whose canonical snapshot/version/hash are all
null uses the legacy compatibility path.

## Current Trigger Points

There are currently three mutation-capable ways post-processing can start, plus one read-only
status consumer.

### 1. Capture Route Trigger

File:

```txt
src/app/api/paypal/orders/capture/route.ts
```

Current behavior:

- Captures the authorized PayPal payment.
- Persists `capturePayload` on the ledger row.
- Reconciles both persisted authorization and completed capture money against the canonical snapshot
  before marking the row captured or scheduling the real paid order fulfillment orchestrator with
  `after(...)`.
- If the capture payload already exists, it does not capture again. It can resume post-processing
  for resumable statuses only after the same full-chain reconciliation passes.

This means a checkout can complete even when the PayPal webhook is unavailable, as long as the Next.js server is running and the capture route finishes successfully.

### 2. PayPal Webhook Trigger

File:

```txt
src/app/api/paypal/webhooks/ledger-transaction-events/route.ts
```

Current behavior:

- Reads the raw webhook body with `req.text()`.
- Optionally verifies the PayPal signature.
- Stores webhook delivery records in `PaypalWebhookEvent`.
- Correlates events to ledger rows using PayPal order ID first, then local `orderToken` from PayPal `custom_id` or `invoice_id`.
- Updates ledger state for PayPal authorization/capture/refund events.
- On `PAYMENT.CAPTURE.COMPLETED`, preserves capture evidence, applies the full canonical
  authorization-plus-capture reconciliation, and schedules the real paid order fulfillment
  orchestrator with `after(...)` only when it passes.
- Persists verified authorization ID/evidence and resynchronizes an order-shaped payload when the
  authorization webhook wins the normal route race.
- Re-reads and compare-and-swaps payment transitions, rebuilding after concurrent ledger changes
  before it schedules fulfillment.
- Still inspects delayed payment evidence for completed rows. A contradiction becomes a durable
  incident, while matching delayed events do not replay fulfillment.
- Does not move `fulfillment_blocked`, `fulfillment_failed`, completed, or other post-capture rows
  backward; in particular, an out-of-order `PAYMENT.CAPTURE.PENDING` event is evidence-only.

### 3. Confirmation Status Route (read-only)

File:

```txt
src/app/api/paypal/tx-ledger/payments/[orderToken]/status/route.ts
```

Current behavior:

- Returns the current ledger status to the confirmation page.
- Performs no post-processing scheduling, provider mutation, or recovery write. Customer-facing
  polling remains outside the mutation trust boundary.

### 4. Admin Retry Trigger

File:

```txt
src/app/admin/shop/paid-order-recovery/actions.ts
```

Current behavior:

- Admin retry calls the real paid order fulfillment orchestrator.
- It blocks if the row is already completed or currently locked.
- It currently acts as a broad retry path, not a fully separated "sync provider details only" action.

## Current Safety Properties

The current flow has important protections:

- PayPal capture uses a stable `paypalRequestId` based on `orderToken`.
- If a ledger row already has `capturePayload`, the capture route returns the stored capture payload instead of capturing again.
- `runPaidFulfillmentProcessing(...)` uses a DB-backed lease through `postProcessingLockId` and `postProcessingLockExpiresAt`.
- The old `runPostProcessing(...)` entrypoint should not remain as an alias-only delegate.
- Webhook events are deduped by PayPal `eventId`.
- `fulfillment_blocked` and `fulfillment_failed` rows are not automatically moved backward by webhook capture events.
- Existing Django/Merchize fulfillment responses are persisted for admin inspection.

## Current Risk Areas

### Status Route Is Read-Only

The confirmation status route now only returns ledger state. It does not schedule `runPaidFulfillmentProcessing(...)` and does not read a status-route resume env flag.

Operational rule:

- Capture route, webhook route, scheduled recovery scanner/cron, and admin actions may request post-processing.
- Confirmation-page polling must stay read-only.
- Webhook downtime should be visible through ledger/admin state instead of hidden by a browser polling side effect.

### Capture Route Is A First-Party Runner

The capture route currently schedules post-processing immediately after capture persistence.

This is not the same as browser-side processing. It is server-side and does not capture money twice. But it means the webhook is not the only completion trigger.

Decision needed:

- Keep capture-route post-processing as the intentional immediate server trigger, with webhook as backup.
- Or make webhook/scheduled recovery the only automatic post-capture trigger.

Accepted alpha default:

- Keep `PAYPAL_TX_LEDGER_ENABLE_CAPTURE_ROUTE_RUNNER=true` explicitly configured so the server can
  begin paid fulfillment immediately after durable capture.
- Treat the route's `after(...)` work as opportunistic. The recovery scanner remains the durable
  completion path if the process exits or a provider is temporarily unavailable.
- Keep the PayPal webhook registered and verified for payment-event reconciliation and later
  capture/refund/dispute events.
- Keep confirmation polling read-only.

Recommended hardened production target:

- Capture route persists capture and may enqueue a durable job.
- Webhook persists provider events and may enqueue the same durable job.
- A scheduled recovery worker scans stuck rows.
- Confirmation status route is read-only.

### `after(...)` Runs In The Same Node Process

Both the capture route and webhook route use `after(...)`.

Benefit:

- The route can respond quickly instead of making PayPal or the browser wait for receipt generation, Django save, and fulfillment push.

Tradeoff:

- If the Node process exits after the response but before the `after(...)` callback finishes, the work can stop mid-run.
- The ledger must be the recovery source of truth.

Recovery paths:

- Admin retry.
- Scheduled recovery scan.
- Webhook resend from PayPal dashboard.

## PayPal Webhook Registration Model

PayPal webhook registrations are PayPal app/payment-mode specific. Deployment environment and PayPal payment mode are separate concerns: a production-deployed app can still run with `PAYPAL_PAYMENT_MODE=sandbox` while real payments are not enabled.

Use separate webhook registrations for:

- Sandbox local/dev.
- Sandbox staging if needed.
- Sandbox production-deployed testing if the deployed app is still using sandbox payments.
- Live payment mode when real payments are enabled.

Do not use a live webhook ID for sandbox transactions.

Recommended payment-mode split:

```txt
# Sandbox payment mode: local, staging, or production-deployed testing
PAYPAL_PAYMENT_MODE=sandbox
NEXT_PUBLIC_PAYPAL_PAYMENT_MODE=sandbox
NEXT_PUBLIC_PAYPAL_SANDBOX_CLIENT_ID=...
PAYPAL_SANDBOX_CLIENT_ID=...
PAYPAL_SANDBOX_CLIENT_SECRET=...
PAYPAL_SANDBOX_NGROK_WEBHOOK_ID=...
PAYPAL_SANDBOX_PRODUCTION_WEBHOOK_ID=...
PAYPAL_SANDBOX_WEBHOOK_PROCESSING_OWNER=sandbox_ngrok # sandbox_ngrok | sandbox_production | none

# Live payment mode: real payments
PAYPAL_PAYMENT_MODE=live
NEXT_PUBLIC_PAYPAL_PAYMENT_MODE=live
NEXT_PUBLIC_PAYPAL_LIVE_CLIENT_ID=...
PAYPAL_LIVE_CLIENT_ID=...
PAYPAL_LIVE_CLIENT_SECRET=...
PAYPAL_LIVE_PRODUCTION_WEBHOOK_ID=...
PAYPAL_LIVE_WEBHOOK_PROCESSING_OWNER=live_production # live_production | none
```

The repository currently resolves these values in:

```txt
src/lib/paypal/serverPayPalConfig.ts
```

Resolution rules:

- `PAYPAL_PAYMENT_MODE=live` uses live credentials and live webhook ID.
- `PAYPAL_PAYMENT_MODE=sandbox` uses sandbox credentials and sandbox webhook IDs.
- Webhook ID env vars identify registered PayPal webhooks that can verify signatures.
- `PAYPAL_SANDBOX_WEBHOOK_PROCESSING_OWNER` decides which sandbox listener can mutate the ledger.
- `PAYPAL_LIVE_WEBHOOK_PROCESSING_OWNER` decides whether the live production listener can mutate the ledger.
- Non-owner webhook deliveries should return `200 OK` and do no ledger, fulfillment, or notification work.
- `PAYPAL_SANDBOX_ADDITIONAL_WEBHOOK_IDS` can hold a comma-separated list for temporary signature verification windows, but additional unnamed IDs should not own processing.
- `NEXT_PUBLIC_PAYPAL_PAYMENT_MODE` should match `PAYPAL_PAYMENT_MODE`.

Recommended ownership split:

```txt
# Local sandbox testing
PAYPAL_PAYMENT_MODE=sandbox
PAYPAL_SANDBOX_WEBHOOK_PROCESSING_OWNER=sandbox_ngrok

# Production-deployed sandbox testing
PAYPAL_PAYMENT_MODE=sandbox
PAYPAL_SANDBOX_WEBHOOK_PROCESSING_OWNER=sandbox_production

# Production live payments
PAYPAL_PAYMENT_MODE=live
PAYPAL_LIVE_WEBHOOK_PROCESSING_OWNER=live_production

# Passive runtime that should ACK but never process
PAYPAL_SANDBOX_WEBHOOK_PROCESSING_OWNER=none
PAYPAL_LIVE_WEBHOOK_PROCESSING_OWNER=none
```

## Domain Strategy

Use one canonical listener URL per PayPal app/payment mode. PayPal posts events to the listener URL registered under the app that created the transaction.

Production-deployed sandbox testing and live payment mode should use the stable production listener URL for the PayPal app/payment mode being registered:

```txt
https://codexchristi.org/next-api/paypal/webhooks/ledger-transaction-events
```

If two public domains point to the same app, do not register both as PayPal webhook listeners for the same app/events unless duplicate delivery is intentional.

Reason:

- PayPal will send events to every subscribed listener.
- Duplicate listener domains add noise and operational complexity.
- Ledger idempotency helps, but the clean live-payment design is one canonical webhook endpoint.

Recommended setup:

```txt
Local dev:
ngrok HTTPS URL registered under the Sandbox app.

Staging:
stable staging HTTPS URL registered under the Sandbox app.

Production-deployed app while still using sandbox payments:
stable production HTTPS URL registered under the Sandbox app.

Live payment mode:
canonical production HTTPS URL registered under the Live app.
```

Live payment mode should not rely on ngrok.

## Signature Verification

Current file:

```txt
src/app/api/paypal/webhooks/ledger-transaction-events/route.ts
```

Current behavior:

```txt
PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION
```

- `required` verifies real sandbox/live webhook deliveries.
- `disabled` skips verification for simulator events or short local debugging windows.

Recommended deployed-webhook rule:

```txt
PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION=required
```

Recommended local simulator/dev rule:

```txt
PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION=disabled
```

Only use skipped verification for local development, webhook simulator cases, or short debugging windows.

## Event Types To Register

The current webhook handler explicitly understands these PayPal event types:

```txt
PAYMENT.AUTHORIZATION.CREATED
PAYMENT.CAPTURE.PENDING
PAYMENT.CAPTURE.COMPLETED
PAYMENT.CAPTURE.DENIED
PAYMENT.CAPTURE.REFUNDED
```

Sandbox and live payment modes can start with those event types.

Future event types likely needed:

```txt
PAYMENT.CAPTURE.REVERSED
CUSTOMER.DISPUTE.CREATED
CUSTOMER.DISPUTE.UPDATED
CUSTOMER.DISPUTE.RESOLVED
```

Do not subscribe to broad wildcard events unless the handler has a clear ignored-event strategy and operational logging.

## Target Backend Architecture

Recommended target:

```mermaid
flowchart TD
  A["PayPal capture route"] --> B["Persist capture payload"]
  B --> C["Enqueue or run paid order fulfillment processing"]
  D["PayPal webhook"] --> E["Verify signature"]
  E --> F["Persist webhook event"]
  F --> C
  C --> G["runPaidFulfillmentProcessing with DB lease"]
  G --> H["Receipt upload"]
  H --> I["Django payment save"]
  I --> J["Catalog-backed fulfillment process"]
  J --> K["Push-to-fulfillment"]
  K --> L["Ledger completed or recovery state"]
  R["Scheduled recovery scan"] --> C
  M["Admin retry"] --> C
  N["Confirmation page"] --> O["Read-only status display"]
```

The long-term rule:

- Capture route, webhook route, scheduled worker, and admin action may all request post-processing.
- `runPaidFulfillmentProcessing(...)` and the ledger lease decide whether work should actually run.
- Customer status polling should not be the main production recovery mechanism.

## Recommended Next Implementation Steps

### Step 1 - Make Trigger Policy Explicit

Add clear env flags:

```txt
PAYPAL_TX_LEDGER_ENABLE_CAPTURE_ROUTE_RUNNER=true
PAYPAL_TX_LEDGER_RECOVERY_SCANNER_ENABLED=true
PAYPAL_TX_LEDGER_RECOVERY_SCANNER_MIN_AGE_MINUTES=15
PAYPAL_TX_LEDGER_RECOVERY_SCANNER_BATCH_SIZE=5
PAYPAL_TX_LEDGER_RECOVERY_SCANNER_SECRET=...
```

Accepted behavior:

- Capture route runner is explicitly enabled for the fast path.
- PayPal webhook processing remains enabled and verified.
- Recovery scanner is enabled as the durable fallback.
- Confirmation status route remains read-only.

### Step 2 - Keep Status Route Read-Only

Runtime:

```txt
src/app/api/paypal/tx-ledger/payments/[orderToken]/status/route.ts
```

Behavior:

- Always return status.
- Never schedule `runPaidFulfillmentProcessing(...)`.
- Do not reintroduce a browser-polling write path unless there is a deliberate production incident fallback plan.

### Step 3 - Register Sandbox Webhook

For sandbox payment mode:

1. Choose the sandbox listener target:
   - local dev through ngrok, or
   - a stable deployed HTTPS URL if the production-deployed app is still using sandbox payments.
2. Register the listener URL under the PayPal Sandbox app.

```txt
https://{ngrok-host}/next-api/paypal/webhooks/ledger-transaction-events
```

or:

```txt
https://codexchristi.org/next-api/paypal/webhooks/ledger-transaction-events
```

3. Store the generated sandbox webhook ID:

```txt
PAYPAL_SANDBOX_NGROK_WEBHOOK_ID=...        # preferred current ngrok listener name
PAYPAL_SANDBOX_PRODUCTION_WEBHOOK_ID=...   # codexchristi.org listener registered under the Sandbox app
```

If you already have a sandbox webhook registered to ngrok, keep that ID in `PAYPAL_SANDBOX_NGROK_WEBHOOK_ID`. Register the production URL as a second sandbox webhook and store that new ID in `PAYPAL_SANDBOX_PRODUCTION_WEBHOOK_ID`.

4. Set:

```txt
PAYPAL_PAYMENT_MODE=sandbox
NEXT_PUBLIC_PAYPAL_PAYMENT_MODE=sandbox
PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION=required
```

5. Use sandbox PayPal credentials and a sandbox ledger/database target.

### Step 4 - Register Live Payment Webhook

Only do this when real payments are ready:

1. Deploy the stable production listener URL.
2. Register that listener under the PayPal Live app:

```txt
https://codexchristi.org/next-api/paypal/webhooks/ledger-transaction-events
```

3. Store the generated live webhook ID:

```txt
PAYPAL_LIVE_PRODUCTION_WEBHOOK_ID=...
```

4. Set:

```txt
PAYPAL_PAYMENT_MODE=live
NEXT_PUBLIC_PAYPAL_PAYMENT_MODE=live
PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION=required
```

### Step 5 - Add Recovery Scanner

Add a scheduled recovery path:

```txt
src/app/api/jobs/paypal-tx-ledger-recovery-scan/route.ts
```

The route is protected by:

```txt
x-cron-secret: PAYPAL_TX_LEDGER_RECOVERY_SCANNER_SECRET
```

Recommended VPS cron cadence:

```txt
every 30 minutes
```

The first automatic scanner version should scan for rows stuck in:

```txt
captured
receipt_uploaded
payment_saved
```

Rules:

- Pick rows older than `PAYPAL_TX_LEDGER_RECOVERY_SCANNER_MIN_AGE_MINUTES`.
- Process at most `PAYPAL_TX_LEDGER_RECOVERY_SCANNER_BATCH_SIZE` rows.
- Process sequentially.
- Do not auto-run generic `error` rows. Show those for admin review first.
- Do not auto-run rows in `fulfillment_blocked`.
- Do not auto-run rows in `fulfillment_failed` unless the saved stage state proves the failure is in a safe, idempotent remaining stage.
- Accepted Django fulfillment-process rows should move to provider registration, external-number lookup, explicit push-to-fulfillment, status/reconciliation, not full payment-side replay.
- Respect active `postProcessingLockExpiresAt`.
- Use the same `runPaidFulfillmentProcessing(orderToken)` entrypoint only when the row is genuinely incomplete.

### Step 6 - Add Webhook Operations Visibility

Admin UI should eventually expose:

- latest webhook event
- webhook event type
- webhook delivery status
- verification failures
- ignored events
- stuck `received` events
- resend guidance from PayPal dashboard

## Acceptance Checklist

- Sandbox webhook ID is separate from live webhook ID.
- A production-deployed app can still use sandbox PayPal payment mode until real payments are ready.
- Sandbox payment mode uses sandbox credentials and `PAYPAL_SANDBOX_NGROK_WEBHOOK_ID` / `PAYPAL_SANDBOX_PRODUCTION_WEBHOOK_ID`.
- Live payment mode uses live credentials and `PAYPAL_LIVE_PRODUCTION_WEBHOOK_ID`.
- Live payment mode uses a stable production domain, not ngrok.
- Only one canonical live payment listener domain is registered for PayPal webhook delivery.
- Deployed environments have `PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION=required` for real PayPal deliveries.
- Webhook events are stored once per PayPal event ID.
- Duplicate webhook deliveries do not duplicate post-processing.
- Capture route does not capture money again when `capturePayload` already exists.
- Confirmation status route is read-only.
- Confirmation page success is based on ledger `completed`, not receipt availability alone.
- Accepted Django 201 fulfillment rows are not shown as "rerun full post-processing" cases.
- Stuck captured/payment-saved rows have an admin or scheduled recovery path.

## Open Questions

Resolved:

1. Capture-route post-processing remains explicitly enabled as the immediate first-party runner.
2. Confirmation status remains read-only.
3. The existing authenticated scheduled route remains the durable recovery mechanism.

Deployment-specific items:

1. Confirm which production domain is the canonical PayPal live payment webhook endpoint.
2. Prefer a stable deployed sandbox URL over local ngrok for repeatable QA.
3. Keep the existing external cron calling the authenticated recovery route and add heartbeat
   observability per the alpha release guide.
