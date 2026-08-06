import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildShippingBandPruneWhere,
  createCatalogRefreshSingleFlight,
  getCatalogGenerationCommitPolicy,
  MerchizeCatalogRefreshInProgressError,
  MerchizeCatalogRefreshLeaseLostError,
  runCatalogLeaseFencedOperation,
} from './sync';

test('partial or capped traversal avoids retirement and invalidates mixed generation proof', () => {
  assert.deepEqual(getCatalogGenerationCommitPolicy(false), {
    markSeenRowsCurrent: false,
    retireUnseenRows: false,
    replaceCompletedGeneration: false,
    invalidateCompletedGeneration: true,
  });
});

test('complete catalog traversal promotes seen rows and retires unseen rows', () => {
  assert.deepEqual(getCatalogGenerationCommitPolicy(true), {
    markSeenRowsCurrent: true,
    retireUnseenRows: true,
    replaceCompletedGeneration: true,
    invalidateCompletedGeneration: false,
  });
});

test('shipping refresh deletes removed zones and deletes every old zone for an empty payload', () => {
  assert.deepEqual(buildShippingBandPruneWhere('variant-1', ['US', 'ROW']), {
    variantId: 'variant-1',
    toZone: { notIn: ['US', 'ROW'] },
  });
  assert.deepEqual(buildShippingBandPruneWhere('variant-1', []), {
    variantId: 'variant-1',
  });
});

test('overlapping in-process catalog refreshes are rejected and the guard releases afterward', async () => {
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const refresh = createCatalogRefreshSingleFlight(async () => {
    calls += 1;
    if (calls === 1) await firstCanFinish;
    return calls;
  });

  const first = refresh();
  await assert.rejects(refresh(), MerchizeCatalogRefreshInProgressError);
  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await refresh(), 2);
});

test('late run A cannot execute a fenced write after run B commits and clears the lease', async () => {
  const state: { activeRunId: string | null; lastCompletedRunId: string | null } = {
    activeRunId: 'run-a',
    lastCompletedRunId: null,
  };
  let staleWriteExecuted = false;

  // Deterministically model run B taking over and committing before run A resumes.
  state.activeRunId = null;
  state.lastCompletedRunId = 'run-b';

  await assert.rejects(
    runCatalogLeaseFencedOperation({
      renewLease: async () => state.activeRunId === 'run-a',
      write: async () => {
        staleWriteExecuted = true;
      },
    }),
    MerchizeCatalogRefreshLeaseLostError,
  );
  assert.equal(staleWriteExecuted, false);
  assert.equal(state.lastCompletedRunId, 'run-b');
});
