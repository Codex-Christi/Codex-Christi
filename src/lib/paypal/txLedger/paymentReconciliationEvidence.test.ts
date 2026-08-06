import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
} from '@/lib/paypal/orderSnapshot/types';
import {
  getPayPalAuthorizationMoney,
  reconcileCanonicalPayPalPaymentChain,
} from './canonicalPaymentReconciliation';
import {
  attachPayPalAuthorizationEvidence,
  getProcessingAuthorizePayload,
} from './paymentReconciliationEvidence';
import type { PaymentLedgerRow } from './paymentReconciliationTypes';

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
    authorizePayload: null,
    capturePayload: null,
    status: 'error',
    lastErrorCode: null,
    lastErrorMessage: null,
    processingCompletedAt: null,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
    updatedAt: new Date('2026-08-06T00:01:00.000Z'),
  };
}

const postCaptureOrder = {
  id: 'paypal-order',
  purchaseUnits: [
    {
      customId: 'order-token',
      amount: { value: '25.00', currencyCode: 'USD' },
      payments: { captures: [] },
    },
  ],
};

const completedCapture = {
  id: 'capture-id',
  status: 'COMPLETED',
  finalCapture: true,
  amount: { value: '25.00', currencyCode: 'USD' },
};

test('combines a post-capture order/customId shape with direct authorization evidence', () => {
  const row = canonicalRow();
  const authorizePayload = getProcessingAuthorizePayload({
    row,
    orderPayload: postCaptureOrder,
    paymentPayload: completedCapture,
    authorizationPayload: {
      id: 'authorization-id',
      status: 'CAPTURED',
      amount: { value: '25.00', currencyCode: 'USD' },
    },
  });

  assert.deepEqual(getPayPalAuthorizationMoney(authorizePayload), {
    value: '25.00',
    currency: 'USD',
  });
  assert.equal(
    reconcileCanonicalPayPalPaymentChain(row, authorizePayload, completedCapture).ok,
    true,
  );
});

test('preserves stored authorization proof when a newer order response omits it', () => {
  const row = canonicalRow();
  row.authorizePayload = {
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
  };

  const authorizePayload = getProcessingAuthorizePayload({
    row,
    orderPayload: postCaptureOrder,
    paymentPayload: completedCapture,
  });

  assert.deepEqual(getPayPalAuthorizationMoney(authorizePayload), {
    value: '25.00',
    currency: 'USD',
  });
});

test('does not invent authorization proof from a post-capture order total', () => {
  const row = canonicalRow();
  const authorizePayload = getProcessingAuthorizePayload({
    row,
    orderPayload: postCaptureOrder,
    paymentPayload: completedCapture,
  });

  assert.equal(getPayPalAuthorizationMoney(authorizePayload), null);
  const chain = reconcileCanonicalPayPalPaymentChain(row, authorizePayload, completedCapture);
  assert.equal(chain.ok, false);
  assert.equal(chain.failedAt, 'authorization');
});

test('refreshes nested order authorization money from direct webhook evidence', () => {
  const storedOrder = {
    ...postCaptureOrder,
    purchaseUnits: [
      {
        ...postCaptureOrder.purchaseUnits[0],
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
  };

  const refreshed = attachPayPalAuthorizationEvidence(storedOrder, {
    id: 'authorization-id',
    amount: { value: '24.99', currencyCode: 'USD' },
  });

  assert.deepEqual(getPayPalAuthorizationMoney(refreshed), {
    value: '24.99',
    currency: 'USD',
  });
});
