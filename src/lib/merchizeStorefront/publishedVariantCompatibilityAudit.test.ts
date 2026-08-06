import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scanPublishedStorefrontVariantCompatibilityInBatches,
  type PublishedVariantCompatibilityBatchOptions,
} from './publishedVariantCompatibilityAudit';
import type { StorefrontVariantCompatibilityScanSummary } from './currentProductLineCompatibility';

function productId(index: number) {
  return `product-${String(index).padStart(3, '0')}`;
}

test('audits every discovered product in deterministic sequential bounded batches', async () => {
  const uniqueProductIds = Array.from({ length: 205 }, (_, index) => productId(index));
  const input = [...uniqueProductIds.toReversed(), ` ${productId(104)} `, productId(0), '', '   '];
  const batches: string[][] = [];
  let activeBatches = 0;
  let maxActiveBatches = 0;

  const scanBatch: NonNullable<PublishedVariantCompatibilityBatchOptions['scanBatch']> = async (
    productIds,
  ) => {
    activeBatches += 1;
    maxActiveBatches = Math.max(maxActiveBatches, activeBatches);
    await Promise.resolve();
    batches.push([...productIds]);
    const batchNumber = batches.length;
    activeBatches -= 1;

    return {
      scannedAt: `2026-08-06T00:00:0${batchNumber}.000Z`,
      productCount: productIds.length,
      variantCount: productIds.length,
      availableCount: productIds.length - 2,
      unavailableCount: 1,
      unverifiedCount: 1,
      autoResolvedCount: batchNumber,
      errors: [{ productId: productIds[0], message: `batch-${batchNumber}-provider-error` }],
      results: productIds.map(
        (id) =>
          ({
            storefrontProductId: id,
          }) as StorefrontVariantCompatibilityScanSummary['results'][number],
      ),
    };
  };

  const summary = await scanPublishedStorefrontVariantCompatibilityInBatches(input, {
    scanBatch,
    maxProductCountPerBatch: 100,
  });

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );
  assert.deepEqual(batches.flat(), uniqueProductIds);
  assert.equal(maxActiveBatches, 1);
  assert.equal(summary.scannedAt, '2026-08-06T00:00:03.000Z');
  assert.equal(summary.productCount, 205);
  assert.equal(summary.variantCount, 205);
  assert.equal(summary.availableCount, 199);
  assert.equal(summary.unavailableCount, 3);
  assert.equal(summary.unverifiedCount, 3);
  assert.equal(summary.autoResolvedCount, 6);
  assert.equal(summary.results.length, 205);
  assert.deepEqual(
    summary.results.map((result) => result.storefrontProductId),
    uniqueProductIds,
  );
  assert.deepEqual(summary.errors, [
    { productId: productId(0), message: 'batch-1-provider-error' },
    { productId: productId(100), message: 'batch-2-provider-error' },
    { productId: productId(200), message: 'batch-3-provider-error' },
  ]);
});

test('rejects batch sizes outside the scanner bound before invoking the scanner', async () => {
  let invoked = false;
  const scanBatch: NonNullable<
    PublishedVariantCompatibilityBatchOptions['scanBatch']
  > = async () => {
    invoked = true;
    throw new Error('must not run');
  };

  await assert.rejects(
    scanPublishedStorefrontVariantCompatibilityInBatches(['product-1'], {
      maxProductCountPerBatch: 0,
      scanBatch,
    }),
    /integer between 1 and 100/,
  );
  await assert.rejects(
    scanPublishedStorefrontVariantCompatibilityInBatches(['product-1'], {
      maxProductCountPerBatch: 101,
      scanBatch,
    }),
    /integer between 1 and 100/,
  );
  assert.equal(invoked, false);
});
