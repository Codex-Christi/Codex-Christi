import assert from 'node:assert/strict';
import test from 'node:test';
import { commitOptimisticLedgerTransition } from './optimisticLedgerTransition';

test('rebuilds a payment transition after a concurrent evidence write wins the first race', async () => {
  const versions = [
    { version: 1, authorizationMatches: true },
    { version: 2, authorizationMatches: false },
  ];
  let loadIndex = 0;
  const committed: string[] = [];

  const result = await commitOptimisticLedgerTransition({
    load: async () => versions[Math.min(loadIndex++, versions.length - 1)],
    build: (row) => (row.authorizationMatches ? 'captured' : 'error'),
    commit: async (row, transition) => {
      if (row.version === 1) return false;
      committed.push(transition);
      return true;
    },
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(committed, ['error']);
});
