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
  buildPayPalCaptureFailureLedgerTransition,
  buildPayPalWebhookLedgerTransition,
  type PayPalWebhookTransitionRow,
} from './payPalWebhookLedgerTransition';
import { PAYPAL_LEDGER_STATUS } from './status';

function row(): PayPalWebhookTransitionRow {
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
    status: PAYPAL_LEDGER_STATUS.AUTHORIZED,
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
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
    lastErrorCode: null,
    lastErrorMessage: null,
    processingCompletedAt: null,
  };
}

const matchingCapture = {
  id: 'capture-id',
  status: 'COMPLETED',
  finalCapture: true,
  amount: { value: '25.00', currencyCode: 'USD' },
};

test('a signed authorization mismatch remains blocking when a later capture matches', () => {
  const original = row();
  const authorization = buildPayPalWebhookLedgerTransition(
    original,
    'PAYMENT.AUTHORIZATION.CREATED',
    {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
  );

  assert.equal(authorization.data?.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(authorization.data?.lastErrorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.deepEqual(getPayPalAuthorizationMoney(authorization.data?.authorizePayload), {
    value: '24.99',
    currency: 'USD',
  });

  const afterAuthorization = {
    ...original,
    ...authorization.data,
  } as PayPalWebhookTransitionRow;
  const capture = buildPayPalWebhookLedgerTransition(
    afterAuthorization,
    'PAYMENT.CAPTURE.COMPLETED',
    matchingCapture,
  );

  assert.equal(capture.data?.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(capture.data?.lastErrorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.equal(capture.shouldScheduleFulfillment, false);
});

test('a later matching authorization and capture cannot erase a durable mismatch', () => {
  const original = row();
  const mismatch = buildPayPalWebhookLedgerTransition(
    original,
    'PAYMENT.AUTHORIZATION.CREATED',
    {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
  );
  const afterMismatch = {
    ...original,
    ...mismatch.data,
  } as PayPalWebhookTransitionRow;
  const matchingAuthorization = buildPayPalWebhookLedgerTransition(
    afterMismatch,
    'PAYMENT.AUTHORIZATION.CREATED',
    {
      id: 'authorization-id',
      amount: { value: '25.00', currencyCode: 'USD' },
    },
  );
  const afterMatchingAuthorization = {
    ...afterMismatch,
    ...matchingAuthorization.data,
  } as PayPalWebhookTransitionRow;
  const matchingCaptureTransition = buildPayPalWebhookLedgerTransition(
    afterMatchingAuthorization,
    'PAYMENT.CAPTURE.COMPLETED',
    matchingCapture,
  );

  assert.equal(matchingAuthorization.data?.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(
    matchingAuthorization.reconciliationFailure?.errorCode,
    'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  );
  assert.deepEqual(getPayPalAuthorizationMoney(matchingAuthorization.data?.authorizePayload), {
    value: '24.99',
    currency: 'USD',
  });
  assert.equal(matchingCaptureTransition.data?.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(
    matchingCaptureTransition.data?.lastErrorCode,
    'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  );
  assert.equal(matchingCaptureTransition.shouldScheduleFulfillment, false);
});

test('a delayed signed authorization mismatch reopens a completed row as an incident', () => {
  const completed = {
    ...row(),
    status: PAYPAL_LEDGER_STATUS.COMPLETED,
    capturePayload: matchingCapture,
    processingCompletedAt: new Date('2026-08-06T00:05:00.000Z'),
  };
  const transition = buildPayPalWebhookLedgerTransition(
    completed,
    'PAYMENT.AUTHORIZATION.CREATED',
    {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
  );

  assert.equal(transition.data?.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(transition.data?.lastErrorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.equal(transition.shouldScheduleFulfillment, false);
});

test('an out-of-order pending event cannot regress a completed capture', () => {
  const captured = {
    ...row(),
    status: PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
    capturePayload: matchingCapture,
  };
  const transition = buildPayPalWebhookLedgerTransition(
    captured,
    'PAYMENT.CAPTURE.PENDING',
    { id: 'capture-id', status: 'PENDING' },
  );

  assert.deepEqual(transition.data, { lastEventType: 'PAYMENT.CAPTURE.PENDING' });
  assert.equal(transition.shouldScheduleFulfillment, false);
});

test('a current pending capture stays pending and preserves its provider evidence', () => {
  const pendingResource = {
    id: 'capture-id',
    status: 'PENDING',
    amount: { value: '25.00', currencyCode: 'USD' },
  };
  const transition = buildPayPalWebhookLedgerTransition(
    row(),
    'PAYMENT.CAPTURE.PENDING',
    pendingResource,
  );

  assert.equal(transition.data?.status, PAYPAL_LEDGER_STATUS.PENDING);
  assert.equal(transition.data?.lastErrorCode, 'CAPTURE_NOT_COMPLETED');
  assert.deepEqual(transition.data?.capturePayload, pendingResource);
  assert.equal(transition.shouldScheduleFulfillment, false);
});

test('a pending capture CAS retry cannot overwrite a concurrently completed capture', async () => {
  const initial = row();
  const completed = {
    ...initial,
    status: PAYPAL_LEDGER_STATUS.CAPTURED,
    capturePayload: matchingCapture,
  };
  const pendingResource = {
    id: 'capture-id',
    status: 'PENDING',
    amount: { value: '25.00', currencyCode: 'USD' },
  };
  let loadCount = 0;
  const committed = await commitOptimisticLedgerTransition({
    load: async () => (loadCount++ === 0 ? initial : completed),
    build: (latest) =>
      buildPayPalWebhookLedgerTransition(
        latest,
        'PAYMENT.CAPTURE.PENDING',
        pendingResource,
      ),
    commit: async (latest) => latest.status === PAYPAL_LEDGER_STATUS.CAPTURED,
  });
  const finalRow = { ...committed.row, ...committed.transition.data };

  assert.equal(committed.attempts, 2);
  assert.equal(finalRow.status, PAYPAL_LEDGER_STATUS.CAPTURED);
  assert.deepEqual(getPayPalCaptureMoney(finalRow.capturePayload), {
    value: '25.00',
    currency: 'USD',
  });
  assert.equal(committed.transition.shouldScheduleFulfillment, false);
});

test('a timeout CAS retry cannot overwrite a concurrently completed capture', async () => {
  const initial = row();
  const completed = {
    ...initial,
    status: PAYPAL_LEDGER_STATUS.CAPTURED,
    capturePayload: matchingCapture,
  };
  let loadCount = 0;
  const committed = await commitOptimisticLedgerTransition({
    load: async () => (loadCount++ === 0 ? initial : completed),
    build: (latest) =>
      buildPayPalCaptureFailureLedgerTransition(latest, {
        code: 'CAPTURE_FAILED',
        message: 'PayPal timed out',
      }),
    commit: async (latest) => latest.status === PAYPAL_LEDGER_STATUS.CAPTURED,
  });
  const finalRow = { ...committed.row, ...committed.transition.data };

  assert.equal(committed.attempts, 2);
  assert.deepEqual(committed.transition.data, { status: PAYPAL_LEDGER_STATUS.CAPTURED });
  assert.equal(finalRow.status, PAYPAL_LEDGER_STATUS.CAPTURED);
  assert.deepEqual(getPayPalCaptureMoney(finalRow.capturePayload), {
    value: '25.00',
    currency: 'USD',
  });
  assert.equal(finalRow.lastErrorCode, null);
});

test('generic capture failure preserves evidence-derived mismatch diagnostics', () => {
  const authorizationMismatch = {
    ...row(),
    status: PAYPAL_LEDGER_STATUS.ERROR,
    authorizePayload: {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    lastErrorCode: 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
    lastErrorMessage: 'Authorization mismatch',
  };
  const captureMismatch = {
    ...row(),
    status: PAYPAL_LEDGER_STATUS.ERROR,
    capturePayload: {
      id: 'capture-id',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    lastErrorCode: 'PAYPAL_CAPTURE_AMOUNT_MISMATCH',
    lastErrorMessage: 'Capture mismatch',
  };
  const failure = { code: 'CAPTURE_FAILED', message: 'PayPal timed out' };
  const authorizationTransition = buildPayPalCaptureFailureLedgerTransition(
    authorizationMismatch,
    failure,
  );
  const captureTransition = buildPayPalCaptureFailureLedgerTransition(captureMismatch, failure);

  assert.equal(
    authorizationTransition.data.lastErrorCode,
    'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  );
  assert.equal(captureTransition.data.lastErrorCode, 'PAYPAL_CAPTURE_AMOUNT_MISMATCH');
});
