import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStrictCatalogGenerationWhere,
  isCatalogRowInCompletedGeneration,
  isMerchizeCatalogGenerationCurrent,
} from './catalog';

const now = new Date('2026-08-06T12:00:00.000Z');

test('catalog proof requires both a completed generation id and completion timestamp', () => {
  assert.equal(isMerchizeCatalogGenerationCurrent(null, now), false);
  assert.equal(
    isMerchizeCatalogGenerationCurrent({ lastCompletedRunId: 'run-1', lastCompletedAt: null }, now),
    false,
  );
});

test('catalog proof expires after the configured currentness window', () => {
  assert.equal(
    isMerchizeCatalogGenerationCurrent(
      { lastCompletedRunId: 'run-1', lastCompletedAt: new Date('2026-08-06T11:00:00.000Z') },
      now,
      2 * 60 * 60 * 1_000,
    ),
    true,
  );
  assert.equal(
    isMerchizeCatalogGenerationCurrent(
      { lastCompletedRunId: 'run-1', lastCompletedAt: new Date('2026-08-06T09:00:00.000Z') },
      now,
      2 * 60 * 60 * 1_000,
    ),
    false,
  );
});

test('catalog proof is unavailable while an in-place refresh is active', () => {
  assert.equal(
    isMerchizeCatalogGenerationCurrent(
      {
        lastCompletedRunId: 'run-1',
        lastCompletedAt: new Date('2026-08-06T11:00:00.000Z'),
        activeRunId: 'run-2',
      },
      now,
      2 * 60 * 60 * 1_000,
    ),
    false,
  );
});

test('late run A writes are fenced out after run B commits', () => {
  const completedRunId = 'run-b';
  const product = { catalogCurrent: true, catalogLastSeenRunId: completedRunId };
  let variant = { catalogCurrent: true, catalogLastSeenRunId: completedRunId };

  assert.equal(isCatalogRowInCompletedGeneration(variant, product, completedRunId), true);

  // Run B has committed and cleared its lease. Expired run A then resumes an already-started
  // write and stamps the row with A. The completed-generation fence must exclude it even though
  // the historical catalogCurrent flag is still true.
  variant = { ...variant, catalogLastSeenRunId: 'run-a' };
  assert.equal(isCatalogRowInCompletedGeneration(variant, product, completedRunId), false);

  assert.deepEqual(buildStrictCatalogGenerationWhere(['SKU-1'], completedRunId), {
    sku: { in: ['SKU-1'] },
    catalogCurrent: true,
    catalogLastSeenRunId: completedRunId,
    product: {
      catalogCurrent: true,
      catalogLastSeenRunId: completedRunId,
    },
  });
});

test('late run A parent writes also fence out otherwise untouched run B variants', () => {
  const completedRunId = 'run-b';
  const variant = { catalogCurrent: true, catalogLastSeenRunId: completedRunId };
  const staleParent = { catalogCurrent: true, catalogLastSeenRunId: 'run-a' };

  assert.equal(isCatalogRowInCompletedGeneration(variant, staleParent, completedRunId), false);
});
