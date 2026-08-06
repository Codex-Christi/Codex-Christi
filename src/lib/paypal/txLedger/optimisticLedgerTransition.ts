export class OptimisticLedgerTransitionConflictError extends Error {
  constructor(message = 'Ledger state changed repeatedly while applying a payment transition.') {
    super(message);
    this.name = 'OptimisticLedgerTransitionConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Rebuilds a transition from fresh ledger state whenever its compare-and-swap write loses a race.
 * Provider network calls stay outside the loop; only deterministic evidence reconciliation is
 * retried.
 */
export async function commitOptimisticLedgerTransition<Row, Transition>(args: {
  load: () => Promise<Row | null>;
  build: (row: Row) => Transition;
  commit: (row: Row, transition: Transition) => Promise<boolean>;
  maxAttempts?: number;
}) {
  const maxAttempts = args.maxAttempts ?? 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const row = await args.load();
    if (!row) throw new Error('Ledger row not found while applying a payment transition.');

    const transition = args.build(row);
    if (await args.commit(row, transition)) return { row, transition, attempts: attempt };
  }

  throw new OptimisticLedgerTransitionConflictError();
}
