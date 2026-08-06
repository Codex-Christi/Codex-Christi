import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeCanonicalOrderSnapshot,
  type CanonicalOrderSnapshotLedgerEnvelope,
} from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  getPayPalAuthorizationMoney,
  reconcileCanonicalPayPalAuthorization,
  reconcileCanonicalPayPalCapture,
  reconcileCanonicalPayPalPaymentChain,
} from './canonicalPaymentReconciliation';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
} from '@/lib/paypal/orderSnapshot/types';

function canonicalEnvelope(): CanonicalOrderSnapshotLedgerEnvelope {
  const snapshot = finalizeCanonicalOrderSnapshot({
    version: CANONICAL_ORDER_SNAPSHOT_VERSION,
    hashAlgorithm: CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
    createdAt: '2026-08-06T00:00:00.000Z',
    destination: { countryIso3: 'USA', region: 'CA' },
    currency: 'EUR',
    lines: [
      {
        lineId: 'product-1:variant-1',
        productId: 'product-1',
        variantId: 'variant-1',
        supplierProductId: 'supplier-product-1',
        supplierVariantId: 'supplier-variant-1',
        sku: 'MERCHIZE-SKU-1',
        sellerSku: 'SELLER-SKU-1',
        title: 'Canonical product',
        selectedOptions: [{ name: 'Size', value: 'Large' }],
        imageUrl: 'https://example.test/image.png',
        quantity: 2,
        unitAmount: { currency: 'EUR', value: '25.00' },
        lineAmount: { currency: 'EUR', value: '50.00' },
        shippingAllocation: { currency: 'EUR', value: '7.00' },
      },
    ],
    subtotal: { currency: 'EUR', value: '50.00' },
    shipping: { currency: 'EUR', value: '7.00' },
    total: { currency: 'EUR', value: '57.00' },
  });

  return {
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  };
}

test('preserves existing behavior only for an all-null legacy envelope', () => {
  const result = reconcileCanonicalPayPalAuthorization(
    {
      canonicalOrderSnapshot: null,
      canonicalOrderSnapshotVersion: null,
      canonicalOrderSnapshotHash: null,
    },
    null,
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'legacy');
});

test('fails closed for partial canonical ledger metadata', () => {
  const envelope = canonicalEnvelope();
  const result = reconcileCanonicalPayPalCapture(
    { ...envelope, canonicalOrderSnapshotHash: null },
    {
      id: 'capture-1',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '57.00', currencyCode: 'EUR' },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CANONICAL_ORDER_SNAPSHOT_INVALID');
});

test('fails closed when external ledger hash metadata does not match the sealed snapshot', () => {
  const result = reconcileCanonicalPayPalAuthorization(
    { ...canonicalEnvelope(), canonicalOrderSnapshotHash: 'f'.repeat(64) },
    { amount: { value: '57.00', currencyCode: 'EUR' } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CANONICAL_ORDER_SNAPSHOT_INVALID');
});

test('reads authorization money from camelCase, snake_case, and direct resources', () => {
  assert.deepEqual(
    getPayPalAuthorizationMoney({
      purchaseUnits: [
        { payments: { authorizations: [{ amount: { value: '57.00', currencyCode: 'EUR' } }] } },
      ],
    }),
    { value: '57.00', currency: 'EUR' },
  );
  assert.deepEqual(
    getPayPalAuthorizationMoney({
      purchase_units: [
        { payments: { authorizations: [{ amount: { value: '57.00', currency_code: 'EUR' } }] } },
      ],
    }),
    { value: '57.00', currency: 'EUR' },
  );
  assert.deepEqual(
    getPayPalAuthorizationMoney({ amount: { value: '57.00', currency_code: 'EUR' } }),
    { value: '57.00', currency: 'EUR' },
  );
});

test('accepts an exact canonical authorization and capture amount', () => {
  const envelope = canonicalEnvelope();
  const authorization = reconcileCanonicalPayPalAuthorization(envelope, {
    amount: { value: '57.0', currencyCode: 'eur' },
  });
  const capture = reconcileCanonicalPayPalCapture(envelope, {
    id: 'capture-1',
    status: 'COMPLETED',
    finalCapture: true,
    amount: { value: '57.00', currencyCode: 'EUR' },
  });

  assert.equal(authorization.ok, true);
  assert.equal(authorization.mode, 'canonical');
  assert.equal(capture.ok, true);
  assert.equal(capture.mode, 'canonical');
});

test('returns durable stage-specific codes for value and currency mismatches', () => {
  const envelope = canonicalEnvelope();
  const authorization = reconcileCanonicalPayPalAuthorization(envelope, {
    amount: { value: '56.99', currencyCode: 'EUR' },
  });
  const capture = reconcileCanonicalPayPalCapture(envelope, {
    id: 'capture-1',
    status: 'COMPLETED',
    finalCapture: true,
    amount: { value: '57.00', currencyCode: 'USD' },
  });

  assert.equal(authorization.ok, false);
  assert.equal(authorization.errorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.equal(capture.ok, false);
  assert.equal(capture.errorCode, 'PAYPAL_CAPTURE_AMOUNT_MISMATCH');
});

test('canonical evidence with a missing PayPal amount fails instead of becoming legacy', () => {
  const result = reconcileCanonicalPayPalAuthorization(canonicalEnvelope(), { status: 'CREATED' });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'canonical');
  assert.equal(result.errorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
  assert.equal(result.money?.code, 'ACTUAL_AMOUNT_MISSING');
});

test('an exact late capture cannot hide a mismatched authorization', () => {
  const envelope = canonicalEnvelope();
  const result = reconcileCanonicalPayPalPaymentChain(
    envelope,
    { amount: { value: '56.99', currencyCode: 'EUR' } },
    {
      id: 'capture-1',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '57.00', currencyCode: 'EUR' },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 'authorization');
  assert.equal(result.reconciliation.errorCode, 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');
});
