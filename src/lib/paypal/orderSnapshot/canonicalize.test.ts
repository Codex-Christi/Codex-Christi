import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalOrderSnapshotHash,
  currencyExponent,
  finalizeCanonicalOrderSnapshot,
  formatMinorAmount,
  InvalidCanonicalOrderSnapshotError,
  parseCanonicalOrderSnapshot,
  parseCanonicalOrderSnapshotFromLedger,
} from './canonicalize';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
  type CanonicalOrderSnapshotDraft,
} from './types';

test('uses PayPal zero-digit precision for HUF, JPY, and TWD', () => {
  for (const currency of ['HUF', 'JPY', 'TWD']) {
    assert.equal(currencyExponent(currency), 0);
    assert.equal(formatMinorAmount(currency, 1234), '1234');
  }

  assert.equal(currencyExponent('EUR'), 2);
  assert.equal(formatMinorAmount('EUR', 1234), '12.34');
});

function draft(): CanonicalOrderSnapshotDraft {
  return {
    version: CANONICAL_ORDER_SNAPSHOT_VERSION,
    hashAlgorithm: CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
    createdAt: '2026-08-06T12:00:00.000Z',
    destination: { countryIso3: 'USA', region: 'CA' },
    currency: 'USD',
    lines: [
      {
        lineId: 'product:variant',
        productId: 'product',
        variantId: 'variant',
        supplierProductId: 'supplier-product',
        supplierVariantId: 'supplier-variant',
        sku: 'MERCHIZE-SKU',
        sellerSku: 'SELLER-SKU',
        title: 'Trusted title',
        selectedOptions: [{ name: 'Size', value: 'M' }],
        imageUrl: 'https://images.example/item.jpg',
        quantity: 2,
        unitAmount: { currency: 'USD', value: '10.00' },
        lineAmount: { currency: 'USD', value: '20.00' },
        shippingAllocation: { currency: 'USD', value: '8.00' },
      },
    ],
    subtotal: { currency: 'USD', value: '20.00' },
    shipping: { currency: 'USD', value: '8.00' },
    total: { currency: 'USD', value: '28.00' },
  };
}

test('finalizes, hashes, parses, and freezes a canonical order snapshot', () => {
  const snapshot = finalizeCanonicalOrderSnapshot(draft());

  assert.equal(snapshot.hash.length, 64);
  assert.equal(
    parseCanonicalOrderSnapshot(JSON.parse(JSON.stringify(snapshot))).hash,
    snapshot.hash,
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.lines), true);
  assert.equal(Object.isFrozen(snapshot.lines[0]), true);
  assert.equal('tax' in snapshot, false);
});

test('stable hashing is independent of object key insertion order', () => {
  const first = draft();
  const second = JSON.parse(JSON.stringify(first)) as CanonicalOrderSnapshotDraft;
  second.destination = {
    region: first.destination.region,
    countryIso3: first.destination.countryIso3,
  };

  assert.equal(computeCanonicalOrderSnapshotHash(first), computeCanonicalOrderSnapshotHash(second));
});

test('rejects arithmetic changes even when the payload still matches its old hash', () => {
  const snapshot = finalizeCanonicalOrderSnapshot(draft());
  const altered = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  (altered.total as { value: string }).value = '27.00';

  assert.throws(() => parseCanonicalOrderSnapshot(altered), InvalidCanonicalOrderSnapshotError);
});

test('strict parser rejects a tax field', () => {
  const snapshot = JSON.parse(JSON.stringify(finalizeCanonicalOrderSnapshot(draft()))) as Record<
    string,
    unknown
  >;
  snapshot.tax = { currency: 'USD', value: '1.00' };

  assert.throws(() => parseCanonicalOrderSnapshot(snapshot), InvalidCanonicalOrderSnapshotError);
});

test('ledger envelope recognizes only an entirely null legacy state', () => {
  assert.deepEqual(
    parseCanonicalOrderSnapshotFromLedger({
      canonicalOrderSnapshot: null,
      canonicalOrderSnapshotVersion: null,
      canonicalOrderSnapshotHash: null,
    }),
    { mode: 'legacy', snapshot: null },
  );

  assert.throws(
    () =>
      parseCanonicalOrderSnapshotFromLedger({
        canonicalOrderSnapshot: null,
        canonicalOrderSnapshotVersion: CANONICAL_ORDER_SNAPSHOT_VERSION,
        canonicalOrderSnapshotHash: null,
      }),
    InvalidCanonicalOrderSnapshotError,
  );
});

test('ledger envelope requires external version and hash to match the sealed snapshot', () => {
  const snapshot = finalizeCanonicalOrderSnapshot(draft());
  const result = parseCanonicalOrderSnapshotFromLedger({
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  });
  assert.equal(result.mode, 'canonical');

  assert.throws(
    () =>
      parseCanonicalOrderSnapshotFromLedger({
        canonicalOrderSnapshot: snapshot,
        canonicalOrderSnapshotVersion: snapshot.version,
        canonicalOrderSnapshotHash: '0'.repeat(64),
      }),
    InvalidCanonicalOrderSnapshotError,
  );
});
