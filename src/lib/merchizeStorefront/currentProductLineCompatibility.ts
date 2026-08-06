import 'server-only';

import { createHash } from 'node:crypto';
import { getCurrentCatalogVariantsBySku } from '@/lib/datasetSearchers/merchize/catalog';
import { merchizeCatalogPrisma } from '@/lib/prisma/shop/merchize/merchizeCatalogPrisma';
import { fetchMerchizeJson } from './providerErrors';
import type { BasicProductInterface, ProductVariantsInterface } from './productTypes';
import {
  fetchStrictLiveStorefrontProductDetails,
  STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS,
  type StrictLiveStorefrontProductDetails,
} from './strictLiveProduct';
import { isMerchizeStorefrontProductAvailable } from '@/lib/paypal/orderSnapshot/merchizeAvailability';
import {
  assertStorefrontVariantCompatibilityInputBounds,
  crossCheckCurrentPresetMatchAgainstCatalog,
  markCurrentPresetCatalogLookupUnavailable,
  matchStorefrontVariantToCurrentPresets,
  parseCurrentProductLinePresetSearchResponse,
  parseStorefrontVariantCompatibilityInput,
  resultFromCurrentCatalogSku,
  isTransientProductLineReason,
  planCompatibilityIncidentMutation,
  summarizeStorefrontVariantOptions,
  type CurrentProductLinePreset,
  type ProductLineCompatibilityReasonCode,
  type ProductLineCompatibilityStatus,
  type ProductLineSupplierIdentity,
  type StorefrontVariant,
  type StorefrontVariantCompatibilityResult,
} from './productLineCompatibility';

const CURRENT_PRESET_SEARCH_URL =
  'https://seller.merchize.com/api/product-line/catalog-products/preset/v2/search';

export const STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS = Object.freeze({
  maxProductCount: 100,
  maxIdentifierLength: 128,
  maxConcurrentProducts: 4,
  maxVariantsPerProduct: 1_000,
  maxDistinctProductLinesPerProduct: 32,
  maxConcurrentPresetRequests: 4,
});

type ProductMetadata = Partial<Pick<BasicProductInterface['data'], '_id' | 'slug' | 'title'>>;

type CurrentCatalogBatch = {
  generationAvailable: boolean;
  variants: ProductLineSupplierIdentity[];
};

export type CurrentProductLineCompatibilityDependencies = {
  fetchCurrentPresets: (productLineName: string) => Promise<CurrentProductLinePreset[]>;
  resolveCurrentCatalogVariants: (skus: string[]) => Promise<CurrentCatalogBatch>;
};

export type ResolveCurrentProductLineCompatibilityOptions = {
  productMetaData?: ProductMetadata;
  persist?: boolean;
  /** Scheduled/admin scans use this to fail the product scan if its incident write fails. */
  requirePersistence?: boolean;
  dependencies?: CurrentProductLineCompatibilityDependencies;
};

export type CompatibilityPersistenceResult = {
  attempted: boolean;
  status: 'persisted' | 'skipped' | 'failed';
  incidentChanges: number;
  error: string | null;
};

export type CurrentProductLineCompatibilityResolution = {
  sellableVariants: ProductVariantsInterface['data'];
  results: StorefrontVariantCompatibilityResult[];
  persistence: CompatibilityPersistenceResult;
};

export type CurrentStorefrontVariantCompatibilityResult = StorefrontVariantCompatibilityResult & {
  persistence: CompatibilityPersistenceResult;
};

export type ProviderStorefrontProductCompatibilityResolution = {
  productMetaData: BasicProductInterface['data'];
  productVariants: ProductVariantsInterface['data'];
  compatibility: CurrentProductLineCompatibilityResolution;
};

export type StorefrontVariantCompatibilityScanSummary = {
  scannedAt: string;
  productCount: number;
  variantCount: number;
  availableCount: number;
  unavailableCount: number;
  unverifiedCount: number;
  autoResolvedCount: number;
  errors: Array<{ productId: string; message: string }>;
  results: StorefrontVariantCompatibilityResult[];
};

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isExplicitlyAvailable(variant: StorefrontVariant) {
  const status = nonEmptyString(variant.status)?.toLowerCase() ?? null;
  return (
    variant.is_active !== false &&
    variant.is_deleted !== true &&
    variant.is_hidden !== true &&
    (!status || status === 'active')
  );
}

function buildResult({
  variant,
  status,
  reasonCode,
  evidence = {},
}: {
  variant: StorefrontVariant;
  status: ProductLineCompatibilityStatus;
  reasonCode: ProductLineCompatibilityReasonCode;
  evidence?: Record<string, unknown>;
}): StorefrontVariantCompatibilityResult {
  const parsed = parseStorefrontVariantCompatibilityInput(variant);
  return {
    status,
    reasonCode,
    storefrontProductId: nonEmptyString(variant.product) ?? '',
    storefrontVariantId: nonEmptyString(variant._id) ?? '',
    storefrontSku: nonEmptyString(variant.sku),
    productLineName: parsed.productLineName,
    selectedOptions: Object.fromEntries(parsed.selectedOptions),
    supplierProductId: null,
    supplierVariantId: null,
    supplierSku: null,
    candidateCount: 0,
    evidence: {
      storefrontOptions: summarizeStorefrontVariantOptions(variant),
      ...evidence,
    },
  };
}

function createDefaultDependencies(): CurrentProductLineCompatibilityDependencies {
  const presetPromises = new Map<string, Promise<CurrentProductLinePreset[]>>();
  const runPresetRequest = createConcurrencyLimiter(
    STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxConcurrentPresetRequests,
  );

  return {
    fetchCurrentPresets(productLineName) {
      const existing = presetPromises.get(productLineName);
      if (existing) return existing;

      const request = runPresetRequest(async () => {
        const response = await fetchMerchizeJson<unknown>(
          CURRENT_PRESET_SEARCH_URL,
          {
            method: 'POST',
            headers: {
              'X-Store-id': process.env.MERCHIZE_STORE_SLUG ?? '27mkjsl',
              'X-API-KEY': process.env.MERCHIZE_API_KEY ?? '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              title: productLineName,
              store_slug: process.env.MERCHIZE_STORE_SLUG ?? '27mkjsl',
              source_screen: 'order-detail',
            }),
            cache: 'no-store',
          },
          { timeoutMs: STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS },
        );
        return parseCurrentProductLinePresetSearchResponse(response);
      });
      presetPromises.set(productLineName, request);
      return request;
    },
    async resolveCurrentCatalogVariants(skus) {
      const result = await getCurrentCatalogVariantsBySku(skus);
      return {
        generationAvailable: result.generationAvailable,
        variants: result.variants.map((variant) => ({
          supplierProductId: variant.supplierProductId,
          supplierVariantId: variant.supplierVariantId,
          supplierSku: variant.sku,
        })),
      };
    },
  };
}

function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        void task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            queue.shift()?.();
          });
      };
      if (active < maxConcurrent) start();
      else queue.push(start);
    });
  };
}

export async function resolveCurrentProductLineCompatibility(
  variants: ProductVariantsInterface['data'],
  options: ResolveCurrentProductLineCompatibilityOptions = {},
): Promise<CurrentProductLineCompatibilityResolution> {
  if (variants.length > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxVariantsPerProduct) {
    throw new Error('Storefront product exceeded its bounded variant compatibility limit.');
  }
  assertStorefrontVariantCompatibilityInputBounds(variants);
  const dependencies = options.dependencies ?? createDefaultDependencies();
  const resultsByVariantId = new Map<string, StorefrontVariantCompatibilityResult>();
  const variantsWithLine = new Map<string, StorefrontVariant[]>();
  const variantsWithoutLine: StorefrontVariant[] = [];

  for (const variant of variants) {
    if (!isExplicitlyAvailable(variant)) {
      resultsByVariantId.set(
        variant._id,
        buildResult({
          variant,
          status: 'unavailable',
          reasonCode: 'STOREFRONT_VARIANT_EXPLICITLY_UNAVAILABLE',
        }),
      );
      continue;
    }

    const productLineName = parseStorefrontVariantCompatibilityInput(variant).productLineName;
    if (!productLineName) {
      variantsWithoutLine.push(variant);
      continue;
    }

    const grouped = variantsWithLine.get(productLineName) ?? [];
    grouped.push(variant);
    variantsWithLine.set(productLineName, grouped);
  }

  if (
    variantsWithLine.size >
    STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxDistinctProductLinesPerProduct
  ) {
    throw new Error('Storefront product exceeded its bounded product-line compatibility limit.');
  }

  await Promise.all(
    [...variantsWithLine.entries()].map(async ([productLineName, groupedVariants]) => {
      try {
        const presets = await dependencies.fetchCurrentPresets(productLineName);
        for (const variant of groupedVariants) {
          resultsByVariantId.set(
            variant._id,
            matchStorefrontVariantToCurrentPresets(variant, presets),
          );
        }
      } catch (error) {
        console.warn('[storefrontVariantCompatibility.current_preset_failed]', {
          productLineName,
          error: error instanceof Error ? error.message : String(error),
        });
        for (const variant of groupedVariants) {
          resultsByVariantId.set(
            variant._id,
            buildResult({
              variant,
              status: 'unverified',
              reasonCode: 'CURRENT_PRESET_PROVIDER_UNAVAILABLE',
              evidence: {
                message: 'Current product-line verification is temporarily unavailable.',
              },
            }),
          );
        }
      }
    }),
  );

  const provisionalPresetMatches = [...resultsByVariantId.values()].filter(
    (result) => result.status === 'available' && result.reasonCode === 'EXACT_CURRENT_PRESET_MATCH',
  );
  const catalogSkus = [
    ...new Set(
      [
        ...variantsWithoutLine.map((variant) => variant.sku),
        ...provisionalPresetMatches.flatMap((result) =>
          result.supplierSku ? [result.supplierSku] : [],
        ),
      ]
        .map((sku) => sku.trim())
        .filter(Boolean),
    ),
  ];

  if (catalogSkus.length) {
    try {
      // Use one bounded lookup so both SKU-only fallbacks and preset matches are checked against
      // the exact same completed supplier-catalog generation.
      const catalog = await dependencies.resolveCurrentCatalogVariants(catalogSkus);
      const currentBySku = new Map(
        catalog.variants.map((variant) => [variant.supplierSku, variant]),
      );
      for (const variant of variantsWithoutLine) {
        resultsByVariantId.set(
          variant._id,
          resultFromCurrentCatalogSku(
            variant,
            currentBySku.get(variant.sku.trim()) ?? null,
            catalog.generationAvailable,
          ),
        );
      }
      for (const result of provisionalPresetMatches) {
        resultsByVariantId.set(
          result.storefrontVariantId,
          crossCheckCurrentPresetMatchAgainstCatalog(
            result,
            result.supplierSku ? (currentBySku.get(result.supplierSku) ?? null) : null,
            catalog.generationAvailable,
          ),
        );
      }
    } catch (error) {
      console.warn('[storefrontVariantCompatibility.current_catalog_lookup_failed]', {
        error: error instanceof Error ? error.message : String(error),
      });
      for (const variant of variantsWithoutLine) {
        resultsByVariantId.set(
          variant._id,
          buildResult({
            variant,
            status: 'unverified',
            reasonCode: 'CURRENT_CATALOG_LOOKUP_UNAVAILABLE',
            evidence: {
              message: 'Current supplier-catalog verification is temporarily unavailable.',
            },
          }),
        );
      }
      for (const result of provisionalPresetMatches) {
        resultsByVariantId.set(
          result.storefrontVariantId,
          markCurrentPresetCatalogLookupUnavailable(result),
        );
      }
    }
  }

  const results = variants.map(
    (variant) =>
      resultsByVariantId.get(variant._id) ??
      buildResult({
        variant,
        status: 'unverified',
        reasonCode: 'CURRENT_CATALOG_LOOKUP_UNAVAILABLE',
      }),
  );

  const transientResults = results.filter((result) =>
    isTransientProductLineReason(result.reasonCode),
  );
  if (transientResults.length) {
    console.warn('[storefrontVariantCompatibility.verification_deferred]', {
      count: transientResults.length,
      reasonCounts: Object.fromEntries(
        [...new Set(transientResults.map((result) => result.reasonCode))].map((reasonCode) => [
          reasonCode,
          transientResults.filter((result) => result.reasonCode === reasonCode).length,
        ]),
      ),
    });
  }

  let persistence: CompatibilityPersistenceResult = {
    attempted: false,
    status: 'skipped',
    incidentChanges: 0,
    error: null,
  };
  if (options.persist !== false) {
    try {
      const incidentChanges = await persistCompatibilityResults(results, options.productMetaData);
      persistence = {
        attempted: true,
        status: 'persisted',
        incidentChanges,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      persistence = {
        attempted: true,
        status: 'failed',
        incidentChanges: 0,
        error: 'Compatibility incident persistence failed.',
      };
      console.error('[storefrontVariantCompatibility.persist_failed]', { error: message });
      if (options.requirePersistence) throw error;
    }
  }

  const availableIds = new Set(
    results
      .filter((result) => result.status === 'available')
      .map((result) => result.storefrontVariantId),
  );
  return {
    sellableVariants: variants.filter((variant) => availableIds.has(variant._id)),
    results,
    persistence,
  };
}

export async function resolveCurrentStorefrontVariantCompatibility(
  variant: StorefrontVariant,
  options: ResolveCurrentProductLineCompatibilityOptions = {},
): Promise<CurrentStorefrontVariantCompatibilityResult> {
  const resolution = await resolveCurrentProductLineCompatibility([variant], options);
  return { ...resolution.results[0], persistence: resolution.persistence };
}

async function resolveStrictLiveProductCompatibility(
  { product, variants }: StrictLiveStorefrontProductDetails,
  options: ResolveCurrentProductLineCompatibilityOptions,
): Promise<ProviderStorefrontProductCompatibilityResolution> {
  if (!isMerchizeStorefrontProductAvailable(product)) {
    return {
      productMetaData: product,
      productVariants: variants,
      compatibility: {
        sellableVariants: [],
        results: variants.map((variant) =>
          buildResult({
            variant,
            status: 'unavailable',
            reasonCode: 'STOREFRONT_PRODUCT_EXPLICITLY_UNAVAILABLE',
          }),
        ),
        persistence: {
          attempted: false,
          status: 'skipped',
          incidentChanges: 0,
          error: null,
        },
      },
    };
  }

  const compatibility = await resolveCurrentProductLineCompatibility(variants, {
    ...options,
    productMetaData: product,
  });
  return { productMetaData: product, productVariants: variants, compatibility };
}

/** Strict provider-only read used by cart and checkout trust decisions. */
export async function resolveProviderStorefrontProductCompatibility(
  productLookup: string,
  options: ResolveCurrentProductLineCompatibilityOptions = {},
): Promise<ProviderStorefrontProductCompatibilityResolution> {
  const details = await fetchStrictLiveStorefrontProductDetails(productLookup);
  return resolveStrictLiveProductCompatibility(details, options);
}

/**
 * Request-action entry point. Only the product/variant IDs cross the trust boundary; the complete
 * variant identity and options are reloaded from Merchize before compatibility is evaluated.
 */
export async function resolveProviderStorefrontVariantCompatibility(
  {
    storefrontProductId,
    storefrontVariantId,
  }: { storefrontProductId: string; storefrontVariantId: string },
  options: ResolveCurrentProductLineCompatibilityOptions = {},
): Promise<CurrentStorefrontVariantCompatibilityResult> {
  const productId = typeof storefrontProductId === 'string' ? storefrontProductId.trim() : '';
  const variantId = typeof storefrontVariantId === 'string' ? storefrontVariantId.trim() : '';
  if (
    !productId ||
    !variantId ||
    productId.length > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxIdentifierLength ||
    variantId.length > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxIdentifierLength
  ) {
    throw new Error('Storefront compatibility identity is invalid.');
  }

  const providerProduct = await resolveProviderStorefrontProductCompatibility(productId, options);
  const trustedVariant = providerProduct.productVariants.find(
    (variant) => variant._id === variantId,
  );
  if (!trustedVariant) {
    return {
      status: 'unavailable',
      reasonCode: 'STOREFRONT_VARIANT_NO_LONGER_RETURNED',
      storefrontProductId: providerProduct.productMetaData._id,
      storefrontVariantId: variantId,
      storefrontSku: null,
      productLineName: null,
      selectedOptions: {},
      supplierProductId: null,
      supplierVariantId: null,
      supplierSku: null,
      candidateCount: 0,
      evidence: {},
      persistence: {
        attempted: false,
        status: 'skipped',
        incidentChanges: 0,
        error: null,
      },
    };
  }
  const result = providerProduct.compatibility.results.find(
    (candidate) => candidate.storefrontVariantId === variantId,
  );
  if (!result) throw new Error('Storefront compatibility result is unavailable.');
  return { ...result, persistence: providerProduct.compatibility.persistence };
}

async function persistCompatibilityResults(
  results: StorefrontVariantCompatibilityResult[],
  productMetaData?: ProductMetadata,
) {
  if (!results.length) return 0;
  const now = new Date();
  let incidentChanges = 0;

  await merchizeCatalogPrisma.$transaction(async (tx) => {
    for (const result of results) {
      // Provider outages and incomplete evidence are request/scan health signals, not repair
      // incidents. In particular, they must not replace a durable manual-repair diagnosis.
      if (isTransientProductLineReason(result.reasonCode)) continue;

      const existing = await tx.storefrontVariantCompatibility.findUnique({
        where: {
          storefrontProductId_storefrontVariantId: {
            storefrontProductId: result.storefrontProductId,
            storefrontVariantId: result.storefrontVariantId,
          },
        },
      });
      const mutation = planCompatibilityIncidentMutation(result, existing);
      if (mutation.action === 'none') continue;
      const providerEvidence = {
        candidateCount: result.candidateCount,
        ...result.evidence,
      };
      const evidenceHash = hashEvidence({
        reasonCode: result.reasonCode,
        selectedOptions: result.selectedOptions,
        supplierProductId: result.supplierProductId,
        supplierVariantId: result.supplierVariantId,
        supplierSku: result.supplierSku,
        providerEvidence,
      });

      if (mutation.action === 'resolve') {
        // Healthy variants do not create rows. They only close a previously opened incident.
        if (!existing) continue;
        await tx.storefrontVariantCompatibility.update({
          where: { id: existing.id },
          data: {
            storefrontProductSlug: productMetaData?.slug ?? undefined,
            storefrontProductTitle: productMetaData?.title ?? undefined,
            storefrontSku: result.storefrontSku,
            supplierProductId: result.supplierProductId,
            supplierVariantId: result.supplierVariantId,
            supplierSku: result.supplierSku,
            productLineName: result.productLineName,
            selectedOptionsJson: result.selectedOptions,
            providerEvidenceJson: providerEvidence,
            evidenceHash,
            status: 'resolved',
            reasonCode: result.reasonCode,
            lastObservedAt: now,
            lastVerifiedAt: now,
            resolvedAt: now,
          },
        });
        incidentChanges += 1;
        continue;
      }

      if (mutation.action === 'create') {
        await tx.storefrontVariantCompatibility.create({
          data: {
            storefrontProductId: result.storefrontProductId,
            storefrontVariantId: result.storefrontVariantId,
            storefrontProductSlug: productMetaData?.slug ?? null,
            storefrontProductTitle: productMetaData?.title ?? null,
            storefrontSku: result.storefrontSku,
            supplierProductId: result.supplierProductId,
            supplierVariantId: result.supplierVariantId,
            supplierSku: result.supplierSku,
            productLineName: result.productLineName,
            selectedOptionsJson: result.selectedOptions,
            providerEvidenceJson: providerEvidence,
            evidenceHash,
            status: 'unavailable',
            reasonCode: result.reasonCode,
            incidentEpisode: mutation.incidentEpisode,
            lastVerifiedAt: now,
            resolvedAt: null,
          },
        });
        incidentChanges += 1;
        continue;
      }

      if (!existing || mutation.action !== 'update') continue;
      await tx.storefrontVariantCompatibility.update({
        where: { id: existing.id },
        data: {
          storefrontProductSlug: productMetaData?.slug ?? undefined,
          storefrontProductTitle: productMetaData?.title ?? undefined,
          storefrontSku: result.storefrontSku,
          supplierProductId: result.supplierProductId,
          supplierVariantId: result.supplierVariantId,
          supplierSku: result.supplierSku,
          productLineName: result.productLineName,
          selectedOptionsJson: result.selectedOptions,
          providerEvidenceJson: providerEvidence,
          evidenceHash,
          status: 'unavailable',
          reasonCode: result.reasonCode,
          occurrenceCount: { increment: 1 },
          incidentEpisode: mutation.incidentEpisode,
          lastObservedAt: now,
          lastVerifiedAt: now,
          resolvedAt: null,
        },
      });
      incidentChanges += 1;
    }
  });

  return incidentChanges;
}

function hashEvidence(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function scanPublishedStorefrontVariantCompatibility(
  rawProductIds: string[],
): Promise<StorefrontVariantCompatibilityScanSummary> {
  const productIds = [...new Set(rawProductIds.map((id) => id.trim()).filter(Boolean))];
  if (
    productIds.length > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxProductCount ||
    productIds.some(
      (id) => id.length > STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxIdentifierLength,
    )
  ) {
    throw new Error('Storefront compatibility scan input exceeds its bounded product limits.');
  }

  const dependencies = createDefaultDependencies();
  const results: StorefrontVariantCompatibilityResult[] = [];
  const errors: Array<{ productId: string; message: string }> = [];
  const resolvedProducts: Array<{
    productId: string;
    productMetaData: ProductMetadata;
    returnedVariantIds: Set<string>;
    results: StorefrontVariantCompatibilityResult[];
  }> = [];
  let autoResolvedCount = 0;
  let persistenceFailureCount = 0;
  let nextIndex = 0;

  const workers = Array.from(
    {
      length: Math.min(
        STOREFRONT_VARIANT_COMPATIBILITY_SCAN_LIMITS.maxConcurrentProducts,
        productIds.length,
      ),
    },
    async () => {
      while (nextIndex < productIds.length) {
        const productId = productIds[nextIndex];
        nextIndex += 1;

        try {
          const details = await fetchStrictLiveStorefrontProductDetails(productId);
          const providerProduct = await resolveStrictLiveProductCompatibility(details, {
            dependencies,
            persist: false,
          });
          resolvedProducts.push({
            productId: providerProduct.productMetaData._id,
            productMetaData: providerProduct.productMetaData,
            returnedVariantIds: new Set(
              providerProduct.productVariants.map((variant) => variant._id),
            ),
            results: providerProduct.compatibility.results,
          });
        } catch (error) {
          errors.push({
            productId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  );
  await Promise.all(workers);

  // Provider reads can run concurrently, but SQLite incident writes are intentionally serialized.
  // A product is included in the successful result set only after its incident transaction lands.
  for (const product of resolvedProducts) {
    try {
      await persistCompatibilityResults(product.results, product.productMetaData);
      autoResolvedCount += await resolveNoLongerReturnedCompatibilityRows(
        product.productId,
        product.returnedVariantIds,
      );
      results.push(...product.results);
    } catch (error) {
      persistenceFailureCount += 1;
      errors.push({
        productId: product.productId,
        message: `Compatibility incident persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (persistenceFailureCount > 0) {
    throw new Error(
      `Storefront compatibility scan failed to persist ${persistenceFailureCount} product result set(s).`,
    );
  }

  return {
    scannedAt: new Date().toISOString(),
    productCount: productIds.length,
    variantCount: results.length,
    availableCount: results.filter((result) => result.status === 'available').length,
    unavailableCount: results.filter((result) => result.status === 'unavailable').length,
    unverifiedCount: results.filter((result) => result.status === 'unverified').length,
    autoResolvedCount,
    errors,
    results,
  };
}

async function resolveNoLongerReturnedCompatibilityRows(
  productId: string,
  returnedVariantIds: Set<string>,
) {
  const openRows = await merchizeCatalogPrisma.storefrontVariantCompatibility.findMany({
    where: {
      storefrontProductId: productId,
      status: { in: ['unavailable', 'unverified'] },
    },
    select: { id: true, storefrontVariantId: true },
  });
  const ids = openRows
    .filter((row) => !returnedVariantIds.has(row.storefrontVariantId))
    .map((row) => row.id);
  if (!ids.length) return 0;

  const now = new Date();
  const result = await merchizeCatalogPrisma.storefrontVariantCompatibility.updateMany({
    where: { id: { in: ids } },
    data: {
      status: 'resolved',
      reasonCode: 'STOREFRONT_VARIANT_NO_LONGER_RETURNED',
      resolvedAt: now,
      lastVerifiedAt: now,
    },
  });
  return result.count;
}
