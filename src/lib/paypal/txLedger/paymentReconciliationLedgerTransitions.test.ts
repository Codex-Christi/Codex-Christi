import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
} from '@/lib/paypal/orderSnapshot/types';
import {
  getPayPalAuthorizationMoney,
  getPayPalCaptureMoney,
} from './canonicalPaymentReconciliation';
import { commitOptimisticLedgerTransition } from './optimisticLedgerTransition';
import {
  buildMissingPaymentReferenceLedgerDecision,
  buildReconciledAuthorizationLedgerDecision,
  buildReconciledCaptureLedgerDecision,
} from './paymentReconciliationLedgerTransitions';
import type { PaymentLedgerRow } from './paymentReconciliationTypes';
import { PAYPAL_LEDGER_STATUS } from './status';

function canonicalRow(): PaymentLedgerRow {
  const snapshot = finalizeCanonicalOrderSnapshot({
    version: CANONICAL_ORDER_SNAPSHOT_VERSION,
    hashAlgorithm: CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
    createdAt: '2026-08-06T00:00:00.000Z',
    destination: { countryIso3: 'USA', region: 'CA' },
    currency: 'USD',
    lines: [
      {
        lineId: 'product:variant',
        productId: 'product',
        variantId: 'variant',
        supplierProductId: 'supplier-product',
        supplierVariantId: 'supplier-variant',
        sku: 'SKU',
        sellerSku: null,
        title: 'Product',
        selectedOptions: [],
        imageUrl: 'https://example.test/product.jpg',
        quantity: 1,
        unitAmount: { currency: 'USD', value: '20.00' },
        lineAmount: { currency: 'USD', value: '20.00' },
        shippingAllocation: { currency: 'USD', value: '5.00' },
      },
    ],
    subtotal: { currency: 'USD', value: '20.00' },
    shipping: { currency: 'USD', value: '5.00' },
    total: { currency: 'USD', value: '25.00' },
  });

  return {
    orderToken: 'order-token',
    paypalOrderId: 'paypal-order',
    paypalAuthorizationId: 'authorization-id',
    customerName: 'Customer',
    customerEmail: 'customer@example.test',
    initialCurrency: 'USD',
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
    authorizePayload: {
      purchaseUnits: [
        {
          customId: 'order-token',
          payments: {
            authorizations: [
              {
                id: 'authorization-id',
                amount: { value: '25.00', currencyCode: 'USD' },
              },
            ],
          },
        },
      ],
    },
    capturePayload: null,
    status: PAYPAL_LEDGER_STATUS.AUTHORIZED,
    lastErrorCode: null,
    lastErrorMessage: null,
    processingCompletedAt: null,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
    updatedAt: new Date('2026-08-06T00:01:00.000Z'),
  };
}

const matchingCapture = {
  id: 'capture-id',
  status: 'COMPLETED',
  finalCapture: true,
  amount: { value: '25.00', currencyCode: 'USD' },
};

test('matching reconciliation authorization and capture cannot erase a durable auth mismatch', () => {
  const mismatch = {
    ...canonicalRow(),
    status: PAYPAL_LEDGER_STATUS.ERROR,
    authorizePayload: {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    lastErrorCode: 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
    lastErrorMessage: 'Authorization mismatch',
  };
  const authorization = buildReconciledAuthorizationLedgerDecision({
    row: mismatch,
    payload: {
      id: 'authorization-id',
      status: 'CREATED',
      amount: { value: '25.00', currencyCode: 'USD' },
    },
  });
  const afterAuthorization = {
    ...mismatch,
    ...authorization.data,
  } as PaymentLedgerRow;
  const capture = buildReconciledCaptureLedgerDecision({
    row: afterAuthorization,
    payload: matchingCapture,
    authorizationPayload: {
      id: 'authorization-id',
      status: 'CAPTURED',
      amount: { value: '25.00', currencyCode: 'USD' },
    },
  });

  assert.equal(authorization.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.deepEqual(getPayPalAuthorizationMoney(authorization.data.authorizePayload), {
    value: '24.99',
    currency: 'USD',
  });
  assert.equal(capture.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(capture.errorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.equal(capture.shouldResumeFulfillment, false);
});

test('a capture CAS retry preserves a concurrently committed signed capture mismatch', async () => {
  const initial = canonicalRow();
  const signedMismatch = {
    ...initial,
    status: PAYPAL_LEDGER_STATUS.ERROR,
    capturePayload: {
      id: 'mismatched-capture-id',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    lastErrorCode: 'PAYPAL_CAPTURE_AMOUNT_MISMATCH',
    lastErrorMessage: 'Capture mismatch',
  };
  let loadCount = 0;
  const committed = await commitOptimisticLedgerTransition({
    load: async () => (loadCount++ === 0 ? initial : signedMismatch),
    build: (row) => buildReconciledCaptureLedgerDecision({ row, payload: matchingCapture }),
    commit: async (_row, decision) => decision.status === PAYPAL_LEDGER_STATUS.ERROR,
  });

  assert.equal(committed.attempts, 2);
  assert.equal(committed.transition.errorCode, 'PAYPAL_CAPTURE_AMOUNT_MISMATCH');
  assert.equal(committed.transition.shouldResumeFulfillment, false);
  assert.deepEqual(getPayPalCaptureMoney(committed.transition.data.capturePayload), {
    value: '24.99',
    currency: 'USD',
  });
});

test('a durable authorization mismatch retains an already completed capture evidence set', () => {
  const signedEvidence = {
    ...canonicalRow(),
    status: PAYPAL_LEDGER_STATUS.ERROR,
    authorizePayload: {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    capturePayload: {
      id: 'signed-capture-id',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    lastErrorCode: 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
    lastErrorMessage: 'Authorization mismatch',
  };
  const transition = buildReconciledCaptureLedgerDecision({
    row: signedEvidence,
    payload: matchingCapture,
  });

  assert.equal(transition.errorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.equal(transition.shouldResumeFulfillment, false);
  assert.deepEqual(getPayPalCaptureMoney(transition.data.capturePayload), {
    value: '24.99',
    currency: 'USD',
  });
});

test('fresh ledger authorization identity wins over a conflicting fetched identity', () => {
  const transition = buildReconciledAuthorizationLedgerDecision({
    row: canonicalRow(),
    payload: {
      id: 'stale-authorization-id',
      status: 'CREATED',
      amount: { value: '25.00', currencyCode: 'USD' },
    },
  });

  assert.equal(transition.data.paypalAuthorizationId, 'authorization-id');
});

test('matching reconciliation observations preserve advanced payment state without resuming', () => {
  const advanced = {
    ...canonicalRow(),
    status: PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
    capturePayload: matchingCapture,
    lastErrorCode: 'FULFILLMENT_RETRY_REQUIRED',
    lastErrorMessage: 'Keep this fulfillment evidence.',
  };
  const capture = buildReconciledCaptureLedgerDecision({
    row: advanced,
    payload: { ...matchingCapture, id: 'stale-matching-capture' },
  });
  const authorization = buildReconciledAuthorizationLedgerDecision({
    row: advanced,
    payload: {
      id: 'stale-authorization',
      status: 'CAPTURED',
      amount: { value: '25.00', currencyCode: 'USD' },
    },
  });

  assert.deepEqual(capture.data, { status: PAYPAL_LEDGER_STATUS.PAYMENT_SAVED });
  assert.equal(capture.shouldResumeFulfillment, false);
  assert.equal(capture.shouldNotify, false);
  assert.deepEqual(authorization.data, { status: PAYPAL_LEDGER_STATUS.PAYMENT_SAVED });
  assert.equal(authorization.shouldNotify, false);
});

test('stale incomplete and missing-reference outcomes cannot regress a completed row', () => {
  const completed = {
    ...canonicalRow(),
    status: PAYPAL_LEDGER_STATUS.COMPLETED,
    capturePayload: matchingCapture,
    processingCompletedAt: new Date('2026-08-06T00:05:00.000Z'),
  };
  const incomplete = buildReconciledCaptureLedgerDecision({
    row: completed,
    payload: { id: 'capture-id', status: 'PENDING' },
  });
  const missing = buildMissingPaymentReferenceLedgerDecision(completed);

  assert.deepEqual(incomplete.data, { status: PAYPAL_LEDGER_STATUS.COMPLETED });
  assert.equal(incomplete.shouldResumeFulfillment, false);
  assert.equal(incomplete.shouldNotify, false);
  assert.deepEqual(missing.data, { status: PAYPAL_LEDGER_STATUS.COMPLETED });
  assert.equal(missing.shouldNotify, false);
});

test('an order ID alone does not hide a genuinely missing authorization or capture reference', () => {
  const orderOnly = {
    ...canonicalRow(),
    paypalAuthorizationId: null,
    authorizePayload: null,
    capturePayload: null,
    status: PAYPAL_LEDGER_STATUS.INTENT_CREATED,
  };
  const missing = buildMissingPaymentReferenceLedgerDecision(orderOnly);

  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'PAYPAL_PAYMENT_REFERENCE_MISSING');
  assert.equal(missing.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(missing.shouldNotify, true);
});
