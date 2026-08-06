import type { CatalogItem } from '@/lib/datasetSearchers/merchize/catalog';
import { iso3ToDest } from '@/lib/datasetSearchers/merchize/dest-map';

export type StrictShippingLineInput = {
  lineId: string;
  sku: string;
  quantity: number;
};

export type StrictShippingQuoteUsd = {
  source: 'MERCHIZE_CATALOG';
  totalUsdCents: number;
  allocationsUsdCents: Record<string, number>;
  rowFallbackSkus: string[];
};

export class StrictShippingResolutionError extends Error {
  readonly code:
    'MISSING_SHIPPING_CATALOG_ROW' | 'INVALID_SHIPPING_BAND' | 'INVALID_SHIPPING_INPUT';
  readonly sku: string | null;

  constructor(
    code: StrictShippingResolutionError['code'],
    message: string,
    sku: string | null = null,
  ) {
    super(message);
    this.name = 'StrictShippingResolutionError';
    this.code = code;
    this.sku = sku;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type ExtrasBySku = ReadonlyMap<string, Record<string, unknown> | undefined>;
type ShippingPair = { first: number | null | undefined; additional: number | null | undefined };

function shippingPair(row: CatalogItem, destination: ReturnType<typeof iso3ToDest>): ShippingPair {
  switch (destination) {
    case 'US':
      return { first: row.US_shipping_fee, additional: row.US_additional_shipping_fee };
    case 'EU':
      return { first: row.EU_shipping_fee, additional: row.EU_additional_shipping_fee };
    case 'GB':
      return { first: row.GB_shipping_fee, additional: row.GB_additional_shipping_fee };
    case 'CA':
      return { first: row.CA_shipping_fee, additional: row.CA_additional_shipping_fee };
    case 'AU':
      return { first: row.AU_shipping_fee, additional: row.AU_additional_shipping_fee };
    case 'ROW':
      return { first: row.ROW_shipping_fee, additional: row.ROW_additional_shipping_fee };
  }
}

function isValidFee(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function resolveStrictBand(
  row: CatalogItem,
  destination: ReturnType<typeof iso3ToDest>,
  sku: string,
) {
  const direct = shippingPair(row, destination);
  if (isValidFee(direct.first) && isValidFee(direct.additional)) {
    return { first: direct.first, additional: direct.additional, usedRowFallback: false };
  }

  // Preserve checkout's existing region-to-ROW fallback, but never invent the historical $7/$5
  // band. A missing ROW band is an order-integrity failure.
  const rowBand = shippingPair(row, 'ROW');
  if (destination !== 'ROW' && isValidFee(rowBand.first) && isValidFee(rowBand.additional)) {
    return { first: rowBand.first, additional: rowBand.additional, usedRowFallback: true };
  }

  throw new StrictShippingResolutionError(
    'INVALID_SHIPPING_BAND',
    `No trusted ${destination} or ROW shipping band exists for SKU ${sku}.`,
    sku,
  );
}

function allocateIntegerTotal(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some((weight) => !isValidFee(weight))) {
    throw new StrictShippingResolutionError(
      'INVALID_SHIPPING_INPUT',
      'Shipping allocation received an unsafe total or weight.',
    );
  }
  if (!weights.length) return [];

  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const effectiveWeights = weightTotal > 0 ? weights : weights.map(() => 1);
  const effectiveTotal = effectiveWeights.reduce((sum, weight) => sum + weight, 0);
  const exact = effectiveWeights.map((weight) => (total * weight) / effectiveTotal);
  const allocations = exact.map(Math.floor);
  let remainder = total - allocations.reduce((sum, value) => sum + value, 0);

  const byLargestFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
    allocations[byLargestFraction[index % byLargestFraction.length].index] += 1;
  }

  return allocations;
}

/**
 * Strict counterpart to the preview shipping calculator. It preserves destination/ROW mapping,
 * the US surcharge, and the existing $5-per-unit minimum, but rejects missing catalog evidence
 * instead of using the unsafe flat $7/$5 fallback.
 */
export function calculateStrictShippingQuoteUsd(input: {
  lines: StrictShippingLineInput[];
  catalogRows: CatalogItem[];
  countryIso3: string;
  extrasBySku?: ExtrasBySku;
}): StrictShippingQuoteUsd {
  if (!input.lines.length) {
    throw new StrictShippingResolutionError(
      'INVALID_SHIPPING_INPUT',
      'A shipping quote requires at least one line.',
    );
  }

  const sortedLines = [...input.lines].sort((a, b) => a.lineId.localeCompare(b.lineId));
  const seenLineIds = new Set<string>();
  for (const line of sortedLines) {
    if (
      !line.lineId ||
      !line.sku ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      seenLineIds.has(line.lineId)
    ) {
      throw new StrictShippingResolutionError(
        'INVALID_SHIPPING_INPUT',
        'Shipping lines require unique IDs, trusted SKUs, and positive integer quantities.',
        line.sku || null,
      );
    }
    seenLineIds.add(line.lineId);
  }

  const catalogBySku = new Map(input.catalogRows.map((row) => [row.SKU_variant, row]));
  const linesBySku = new Map<string, StrictShippingLineInput[]>();
  for (const line of sortedLines) {
    const group = linesBySku.get(line.sku);
    if (group) group.push(line);
    else linesBySku.set(line.sku, [line]);
  }

  const destination = iso3ToDest(input.countryIso3);
  const rawAllocationByLine = new Map<string, number>();
  const rowFallbackSkus: string[] = [];

  for (const [sku, skuLines] of [...linesBySku.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const catalogRow = catalogBySku.get(sku);
    if (!catalogRow) {
      throw new StrictShippingResolutionError(
        'MISSING_SHIPPING_CATALOG_ROW',
        `No shipping catalog row exists for SKU ${sku}.`,
        sku,
      );
    }

    const band = resolveStrictBand(catalogRow, destination, sku);
    if (band.usedRowFallback) rowFallbackSkus.push(sku);

    const surchargeValue = input.extrasBySku?.get(sku)?.['us_post_service_added_fee'];
    const surcharge = destination === 'US' && isValidFee(surchargeValue) ? surchargeValue : 0;

    let firstUnitAssigned = false;
    for (const line of skuLines) {
      const firstUnits = firstUnitAssigned ? 0 : 1;
      const additionalUnits = line.quantity - firstUnits;
      const rawCost =
        firstUnits * band.first +
        additionalUnits * band.additional +
        (!firstUnitAssigned ? surcharge : 0);
      rawAllocationByLine.set(line.lineId, rawCost);
      firstUnitAssigned = true;
    }
  }

  const rawShippingUsd = [...rawAllocationByLine.values()].reduce((sum, value) => sum + value, 0);
  const totalUnits = sortedLines.reduce((sum, line) => sum + line.quantity, 0);
  const minimumShippingUsd = 5 * totalUnits;
  const floorApplied = rawShippingUsd < minimumShippingUsd;
  const totalUsdCents = Math.ceil(
    (Math.max(rawShippingUsd, minimumShippingUsd) - Number.EPSILON) * 100,
  );
  if (!Number.isSafeInteger(totalUsdCents)) {
    throw new StrictShippingResolutionError(
      'INVALID_SHIPPING_INPUT',
      'Shipping total exceeds the supported safe range.',
    );
  }

  const weights = sortedLines.map((line) =>
    floorApplied ? line.quantity : (rawAllocationByLine.get(line.lineId) ?? 0),
  );
  const allocations = allocateIntegerTotal(totalUsdCents, weights);

  return {
    source: 'MERCHIZE_CATALOG',
    totalUsdCents,
    allocationsUsdCents: Object.fromEntries(
      sortedLines.map((line, index) => [line.lineId, allocations[index]]),
    ),
    rowFallbackSkus,
  };
}
