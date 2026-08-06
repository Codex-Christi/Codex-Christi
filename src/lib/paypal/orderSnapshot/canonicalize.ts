import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PAYPAL_ZERO_DIGIT_CURRENCY_CODES } from '@/datasets/shop_general/paypal_currency_specifics';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
  type CanonicalMoney,
  type CanonicalOrderSnapshot,
  type CanonicalOrderSnapshotDraft,
} from './types';

const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const moneySchema = z
  .object({
    currency: currencySchema,
    value: z.string().regex(/^\d+(?:\.\d+)?$/),
  })
  .strict();
const optionSchema = z
  .object({
    name: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();
const lineSchema = z
  .object({
    lineId: z.string().min(1),
    productId: z.string().min(1),
    variantId: z.string().min(1),
    supplierProductId: z.string().min(1),
    supplierVariantId: z.string().min(1),
    sku: z.string().min(1),
    sellerSku: z.string().min(1).nullable(),
    title: z.string().min(1),
    selectedOptions: z.array(optionSchema),
    imageUrl: z.string().min(1),
    quantity: z.number().int().positive().safe(),
    unitAmount: moneySchema,
    lineAmount: moneySchema,
    shippingAllocation: moneySchema,
  })
  .strict();
const destinationSchema = z
  .object({
    countryIso3: z.string().regex(/^[A-Z]{3}$/),
    region: z.string().min(1).nullable(),
  })
  .strict();
const draftSchema = z
  .object({
    version: z.literal(CANONICAL_ORDER_SNAPSHOT_VERSION),
    hashAlgorithm: z.literal(CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM),
    createdAt: z.string().min(1),
    destination: destinationSchema,
    currency: currencySchema,
    lines: z.array(lineSchema).min(1),
    subtotal: moneySchema,
    shipping: moneySchema,
    total: moneySchema,
  })
  .strict();
const snapshotSchema = draftSchema
  .extend({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class InvalidCanonicalOrderSnapshotError extends Error {
  readonly code = 'INVALID_CANONICAL_ORDER_SNAPSHOT' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidCanonicalOrderSnapshotError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function currencyExponent(currency: string): 0 | 2 {
  return PAYPAL_ZERO_DIGIT_CURRENCY_CODES.includes(
    currency.toUpperCase() as (typeof PAYPAL_ZERO_DIGIT_CURRENCY_CODES)[number],
  )
    ? 0
    : 2;
}

export function formatMinorAmount(currency: string, minorAmount: number | bigint): string {
  const value = typeof minorAmount === 'bigint' ? minorAmount : BigInt(minorAmount);
  if (value < BigInt(0)) throw new RangeError('Money cannot be negative.');

  if (currencyExponent(currency) === 0) return value.toString();

  const whole = value / BigInt(100);
  const fraction = String(value % BigInt(100)).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function moneyFromMinor(currency: string, minorAmount: number | bigint): CanonicalMoney {
  const normalizedCurrency = currency.toUpperCase();
  return {
    currency: normalizedCurrency,
    value: formatMinorAmount(normalizedCurrency, minorAmount),
  };
}

export function moneyToMinor(money: CanonicalMoney): bigint {
  const exponent = currencyExponent(money.currency);
  const expectedPattern = exponent === 0 ? /^\d+$/ : /^\d+\.\d{2}$/;
  if (!expectedPattern.test(money.value)) {
    throw new InvalidCanonicalOrderSnapshotError(
      `Money value ${money.value} is not normalized for ${money.currency}.`,
    );
  }

  return exponent === 0 ? BigInt(money.value) : BigInt(money.value.replace('.', ''));
}

function assertFiniteCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== createdAt) {
    throw new InvalidCanonicalOrderSnapshotError('Snapshot createdAt must be an ISO timestamp.');
  }
}

function assertMoneyCurrency(money: CanonicalMoney, expectedCurrency: string, field: string) {
  if (money.currency !== expectedCurrency) {
    throw new InvalidCanonicalOrderSnapshotError(`${field} currency does not match the snapshot.`);
  }
  moneyToMinor(money);
}

function assertSnapshotArithmetic(snapshot: CanonicalOrderSnapshotDraft) {
  assertFiniteCreatedAt(snapshot.createdAt);

  const seenLineIds = new Set<string>();
  let expectedSubtotal = BigInt(0);
  let expectedShipping = BigInt(0);

  for (const line of snapshot.lines) {
    if (seenLineIds.has(line.lineId)) {
      throw new InvalidCanonicalOrderSnapshotError(`Duplicate canonical line ID: ${line.lineId}.`);
    }
    seenLineIds.add(line.lineId);

    assertMoneyCurrency(line.unitAmount, snapshot.currency, `${line.lineId}.unitAmount`);
    assertMoneyCurrency(line.lineAmount, snapshot.currency, `${line.lineId}.lineAmount`);
    assertMoneyCurrency(
      line.shippingAllocation,
      snapshot.currency,
      `${line.lineId}.shippingAllocation`,
    );

    const unitMinor = moneyToMinor(line.unitAmount);
    const lineMinor = moneyToMinor(line.lineAmount);
    const expectedLineMinor = unitMinor * BigInt(line.quantity);
    if (lineMinor !== expectedLineMinor) {
      throw new InvalidCanonicalOrderSnapshotError(
        `Canonical line amount does not equal unit amount times quantity for ${line.lineId}.`,
      );
    }

    expectedSubtotal += lineMinor;
    expectedShipping += moneyToMinor(line.shippingAllocation);
  }

  assertMoneyCurrency(snapshot.subtotal, snapshot.currency, 'subtotal');
  assertMoneyCurrency(snapshot.shipping, snapshot.currency, 'shipping');
  assertMoneyCurrency(snapshot.total, snapshot.currency, 'total');

  if (moneyToMinor(snapshot.subtotal) !== expectedSubtotal) {
    throw new InvalidCanonicalOrderSnapshotError('Snapshot subtotal does not equal its lines.');
  }
  if (moneyToMinor(snapshot.shipping) !== expectedShipping) {
    throw new InvalidCanonicalOrderSnapshotError(
      'Snapshot shipping does not equal its line allocations.',
    );
  }
  if (moneyToMinor(snapshot.total) !== expectedSubtotal + expectedShipping) {
    throw new InvalidCanonicalOrderSnapshotError(
      'Snapshot total must equal merchandise subtotal plus shipping.',
    );
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }

  throw new TypeError(`Canonical JSON cannot contain ${typeof value}.`);
}

export function computeCanonicalOrderSnapshotHash(snapshot: CanonicalOrderSnapshotDraft): string {
  return createHash(CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM)
    .update(stableJson(snapshot), 'utf8')
    .digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

export function finalizeCanonicalOrderSnapshot(
  untrustedDraft: CanonicalOrderSnapshotDraft,
): CanonicalOrderSnapshot {
  let draft: CanonicalOrderSnapshotDraft;
  try {
    draft = draftSchema.parse(untrustedDraft) as CanonicalOrderSnapshotDraft;
    assertSnapshotArithmetic(draft);
  } catch (error) {
    if (error instanceof InvalidCanonicalOrderSnapshotError) throw error;
    throw new InvalidCanonicalOrderSnapshotError('Cannot finalize an invalid order snapshot.', {
      cause: error,
    });
  }

  return deepFreeze({
    ...draft,
    hash: computeCanonicalOrderSnapshotHash(draft),
  });
}

export function verifyCanonicalOrderSnapshotHash(snapshot: CanonicalOrderSnapshot): boolean {
  const { hash, ...draft } = snapshot;
  return hash === computeCanonicalOrderSnapshotHash(draft);
}

export function parseCanonicalOrderSnapshot(value: unknown): CanonicalOrderSnapshot {
  let snapshot: CanonicalOrderSnapshot;
  try {
    snapshot = snapshotSchema.parse(value) as CanonicalOrderSnapshot;
    assertSnapshotArithmetic(snapshot);
  } catch (error) {
    if (error instanceof InvalidCanonicalOrderSnapshotError) throw error;
    throw new InvalidCanonicalOrderSnapshotError('Persisted canonical order snapshot is invalid.', {
      cause: error,
    });
  }

  if (!verifyCanonicalOrderSnapshotHash(snapshot)) {
    throw new InvalidCanonicalOrderSnapshotError('Canonical order snapshot hash does not match.');
  }

  return deepFreeze(snapshot);
}

export function isCanonicalOrderSnapshot(value: unknown): value is CanonicalOrderSnapshot {
  try {
    parseCanonicalOrderSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

export type CanonicalOrderSnapshotLedgerEnvelope = {
  canonicalOrderSnapshot: unknown | null;
  canonicalOrderSnapshotVersion: string | null;
  canonicalOrderSnapshotHash: string | null;
};

export type ParsedCanonicalOrderSnapshotLedgerEnvelope =
  { mode: 'legacy'; snapshot: null } | { mode: 'canonical'; snapshot: CanonicalOrderSnapshot };

/**
 * The only supported persisted-snapshot entry point. Pre-P0.2 rows are legacy only when all three
 * additive ledger fields are null. Partial fields, invalid JSON, or external metadata that does
 * not match the sealed snapshot are corruption and fail closed.
 */
export function parseCanonicalOrderSnapshotFromLedger(
  envelope: CanonicalOrderSnapshotLedgerEnvelope,
): ParsedCanonicalOrderSnapshotLedgerEnvelope {
  const snapshotIsNull = envelope.canonicalOrderSnapshot === null;
  const versionIsNull = envelope.canonicalOrderSnapshotVersion === null;
  const hashIsNull = envelope.canonicalOrderSnapshotHash === null;

  if (snapshotIsNull && versionIsNull && hashIsNull) {
    return { mode: 'legacy', snapshot: null };
  }
  if (snapshotIsNull || versionIsNull || hashIsNull) {
    throw new InvalidCanonicalOrderSnapshotError(
      'Canonical order snapshot ledger fields are only partially populated.',
    );
  }

  const snapshot = parseCanonicalOrderSnapshot(envelope.canonicalOrderSnapshot);
  if (envelope.canonicalOrderSnapshotVersion !== snapshot.version) {
    throw new InvalidCanonicalOrderSnapshotError(
      'Canonical order snapshot version does not match its ledger metadata.',
    );
  }
  if (envelope.canonicalOrderSnapshotHash !== snapshot.hash) {
    throw new InvalidCanonicalOrderSnapshotError(
      'Canonical order snapshot hash does not match its ledger metadata.',
    );
  }

  return { mode: 'canonical', snapshot };
}
