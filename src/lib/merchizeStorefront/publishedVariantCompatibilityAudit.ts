import 'server-only';

import { PUBLISHED_SHOP_PRODUCT_IDS } from '@/lib/utils/shopHomePageProductsData';
import {
  scanPublishedStorefrontVariantCompatibility,
  STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS,
  type StorefrontVariantCompatibilityScanSummary,
} from './currentProductLineCompatibility';

type CompatibilityBatchScanner = (
  productIds: string[],
) => Promise<StorefrontVariantCompatibilityScanSummary>;

export type PublishedVariantCompatibilityBatchOptions = {
  scanBatch?: CompatibilityBatchScanner;
  maxProductCountPerBatch?: number;
};

export type PublishedVariantCompatibilityAuditResult =
  | {
      ok: true;
      scannedAt: string;
      productCount: number;
      variantCount: number;
      availableCount: number;
      unavailableCount: number;
      unverifiedCount: number;
      autoResolvedCount: number;
      scanErrors: Array<{ productId: string; message: string }>;
    }
  | {
      ok: false;
      error: string;
    };

function compareProductIds(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The underlying scanner intentionally rejects more than 100 products and runs at most four
 * product workers. Snapshot refreshes may discover more products, so this orchestration layer
 * globally normalizes them, creates stable chunks, and awaits each chunk in sequence. That keeps
 * the scanner's concurrency ceiling intact while returning one complete summary.
 */
export async function scanPublishedStorefrontVariantCompatibilityInBatches(
  rawProductIds: readonly string[],
  options: PublishedVariantCompatibilityBatchOptions = {},
): Promise<StorefrontVariantCompatibilityScanSummary> {
  const scanBatch = options.scanBatch ?? scanPublishedStorefrontVariantCompatibility;
  const maxProductCountPerBatch =
    options.maxProductCountPerBatch ?? STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxProductCount;

  if (
    !Number.isInteger(maxProductCountPerBatch) ||
    maxProductCountPerBatch < 1 ||
    maxProductCountPerBatch > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxProductCount
  ) {
    throw new Error(
      `Storefront compatibility audit batch size must be an integer between 1 and ${STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxProductCount}.`,
    );
  }

  const productIds = [...new Set(rawProductIds.map((id) => id.trim()).filter(Boolean))].sort(
    compareProductIds,
  );
  if (
    productIds.some(
      (id) => id.length > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxIdentifierLength,
    )
  ) {
    throw new Error('Storefront compatibility scan input exceeds its bounded product limits.');
  }

  let scannedAt = new Date().toISOString();
  let productCount = 0;
  let variantCount = 0;
  let availableCount = 0;
  let unavailableCount = 0;
  let unverifiedCount = 0;
  let autoResolvedCount = 0;
  const errors: StorefrontVariantCompatibilityScanSummary['errors'] = [];
  const results: StorefrontVariantCompatibilityScanSummary['results'] = [];

  for (let offset = 0; offset < productIds.length; offset += maxProductCountPerBatch) {
    const summary = await scanBatch(productIds.slice(offset, offset + maxProductCountPerBatch));
    scannedAt = summary.scannedAt;
    productCount += summary.productCount;
    variantCount += summary.variantCount;
    availableCount += summary.availableCount;
    unavailableCount += summary.unavailableCount;
    unverifiedCount += summary.unverifiedCount;
    autoResolvedCount += summary.autoResolvedCount;
    errors.push(...summary.errors);
    results.push(...summary.results);
  }

  return {
    scannedAt,
    productCount,
    variantCount,
    availableCount,
    unavailableCount,
    unverifiedCount,
    autoResolvedCount,
    errors,
    results,
  };
}

/**
 * Audits only the explicitly published storefront products. A catalog/snapshot refresh remains
 * successful when this operational follow-up fails, but callers receive the failure so it is never
 * mistaken for a completed compatibility scan.
 */
export async function runPublishedVariantCompatibilityAudit(
  productIds: readonly string[] = PUBLISHED_SHOP_PRODUCT_IDS,
): Promise<PublishedVariantCompatibilityAuditResult> {
  try {
    const scan = await scanPublishedStorefrontVariantCompatibilityInBatches(productIds);

    return {
      ok: true,
      scannedAt: scan.scannedAt,
      productCount: scan.productCount,
      variantCount: scan.variantCount,
      availableCount: scan.availableCount,
      unavailableCount: scan.unavailableCount,
      unverifiedCount: scan.unverifiedCount,
      autoResolvedCount: scan.autoResolvedCount,
      scanErrors: scan.errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[storefrontVariantCompatibility.audit_failed]', { error: message });
    return { ok: false, error: message };
  }
}
