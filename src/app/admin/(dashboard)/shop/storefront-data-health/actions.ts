// src/app/admin/shop/storefront-data-health/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { writeAdminAuditLog } from '@/lib/admin/admin-auth-ledger';
import { getAdminActionErrorMessage, requireAdminAction } from '@/lib/admin/require-admin';
import { merchizeCatalogPrisma } from '@/lib/prisma/shop/merchize/merchizeCatalogPrisma';
import { refreshMerchizeCatalog } from '@/lib/merchizeCatalog/sync';
import { STOREFRONT_SNAPSHOT_CATEGORY_SLUGS } from '@/lib/merchizeStorefront/categories';
import {
  fetchCategoryProducts,
  getCategoryMetadataFromMerchize,
} from '@/app/shop/category/[id]/categoryDetailsSSR';
import {
  fetchBaseProduct,
  merchizeAPIKey,
  merchizeBaseURL,
} from '@/app/shop/product/[id]/productDetailsSSR';
import { getCategoryPagePath } from '@/lib/utils/shop/categoryPagePath';
import {
  PUBLISHED_SHOP_PRODUCT_IDS,
  getPublishedShopProductPreview,
} from '@/lib/utils/shopHomePageProductsData';
import { generateShopSeoManifest } from '@/lib/shop/seoManifest/generate';
import {
  readCategorySeoManifestEntry,
  readProductSeoManifestEntry,
  readShopSeoManifestStats,
} from '@/lib/shop/seoManifest/read';
import type { ShopMetadataSource } from '@/lib/shop/seoManifest/metadataObservability';
import {
  fetchMerchizeJson,
  coerceMerchizeProviderError,
} from '@/lib/merchizeStorefront/providerErrors';
import type { BasicProductInterface } from '@/lib/merchizeStorefront/productTypes';
import {
  assertBasicStorefrontProductData,
  getBasicProductFromSnapshot,
  getCategoryMetadataFromSnapshot,
  normalizeStorefrontCategorySlug,
} from '@/lib/merchizeStorefront/snapshot';
import { runPublishedVariantCompatibilityAudit } from '@/lib/merchizeStorefront/publishedVariantCompatibilityAudit';

type StorefrontDataHealthWarningSeverity = 'info' | 'warning' | 'critical';

type StorefrontDataHealthWarning = {
  code:
    | 'seo_manifest_missing'
    | 'seo_manifest_stale'
    | 'seo_manifest_missing_coverage'
    | 'seo_manifest_warnings'
    | 'storefront_snapshot_missing'
    | 'storefront_snapshot_ttl_expired';
  severity: StorefrontDataHealthWarningSeverity;
  message: string;
};

type MetadataSourceDiagnostic = {
  targetKind: 'product' | 'category';
  targetId: string;
  source: ShopMetadataSource;
  shouldIndex: boolean;
  ok: boolean;
  message: string;
};

type SourceCountMap = Record<ShopMetadataSource, number>;

type PublishedProductVerificationStatus = 'available' | 'missing_remote' | 'provider_error';

type PublishedProductVerificationItem = {
  productId: string;
  expectedTitle: string;
  status: PublishedProductVerificationStatus;
  remoteTitle: string | null;
  message: string;
  statusCode: number | null;
};

function getEmptyStorefrontSnapshotStats() {
  return {
    productCount: 0,
    categoryCount: 0,
    variantSnapshotCount: 0,
    lastProductSnapshotAt: null,
    lastCategorySnapshotAt: null,
    latestSnapshotAt: null,
    snapshotTtlExpired: false,
    ttlDays: process.env.MERCHIZE_STOREFRONT_SNAPSHOT_TTL_DAYS ?? '1',
    healthWarnings: [
      {
        code: 'storefront_snapshot_missing' as const,
        severity: 'critical' as const,
        message: 'No storefront snapshot data is available.',
      },
    ],
    seoManifest: {
      activeGeneration: null,
      generatedAt: null,
      productCount: 0,
      categoryCount: 0,
      missingPublishedProductIds: [],
      missingCategorySlugs: [],
      manifestPath: '',
      retainedGenerationCount: 0,
      lastPrunedGenerationCount: 0,
      warnings: [],
      isStale: false,
    },
  };
}

function getFailedSeoManifestResult(message: string) {
  return {
    ok: false as const,
    activeGeneration: null,
    generatedAt: null,
    productCount: 0,
    categoryCount: 0,
    missingPublishedProductIds: [],
    missingCategorySlugs: [],
    manifestPath: '',
    retainedGenerationCount: 0,
    lastPrunedGenerationCount: 0,
    warnings: [],
    prunedGenerations: [],
    affectedRoutes: [],
    error: message,
  };
}

// const v = await merchizeCatalogPrisma.variant.findUnique({
//   where: { sku: 'FBJSVN000000AA02' },
//   select: {
//     sku: true,
//     tier1Price: true,
//     tier2Price: true,
//     tier3Price: true,
//     shippingBands: true,
//     tiersJson: true,
//   },
// });

// console.log('>>> Inspect variant FBJSVN000000AA02', v);

export async function getStorefrontSnapshotStats() {
  await requireAdminAction('shop.view');

  const [productCount, categoryCount, variantAgg, latestProduct, latestCategory, seoManifest] =
    await Promise.all([
      merchizeCatalogPrisma.storefrontProductSnapshot.count(),
      merchizeCatalogPrisma.storefrontCategorySnapshot.count(),
      merchizeCatalogPrisma.storefrontProductSnapshot.aggregate({
        _sum: { variantCount: true },
      }),
      merchizeCatalogPrisma.storefrontProductSnapshot.findFirst({
        orderBy: { lastSeenAt: 'desc' },
        select: { lastSeenAt: true },
      }),
      merchizeCatalogPrisma.storefrontCategorySnapshot.findFirst({
        orderBy: { lastSuccessfulFetchAt: 'desc' },
        select: { lastSuccessfulFetchAt: true },
      }),
      readShopSeoManifestStats().catch((err) => {
        console.warn('[shopSeoManifest] stats read failed:', err);
        return null;
      }),
    ]);
  const ttlDays = process.env.MERCHIZE_STOREFRONT_SNAPSHOT_TTL_DAYS ?? '1';
  const latestSnapshotAt = maxDate(
    latestProduct?.lastSeenAt ?? null,
    latestCategory?.lastSuccessfulFetchAt ?? null,
  );
  const snapshotTtlExpired = isSnapshotTtlExpired(latestSnapshotAt, ttlDays);
  const seoManifestStats = seoManifest ?? {
    activeGeneration: null,
    generatedAt: null,
    productCount: 0,
    categoryCount: 0,
    missingPublishedProductIds: [],
    missingCategorySlugs: [],
    manifestPath: '',
    retainedGenerationCount: 0,
    lastPrunedGenerationCount: 0,
    warnings: [],
  };
  const manifestIsStale = isSeoManifestStale(seoManifestStats.generatedAt, latestSnapshotAt);
  const healthWarnings = buildStorefrontDataHealthWarnings({
    latestSnapshotAt,
    snapshotTtlExpired,
    seoManifest: seoManifestStats,
    manifestIsStale,
  });

  return {
    productCount,
    categoryCount,
    variantSnapshotCount: variantAgg._sum.variantCount ?? 0,
    lastProductSnapshotAt: latestProduct?.lastSeenAt ?? null,
    lastCategorySnapshotAt: latestCategory?.lastSuccessfulFetchAt ?? null,
    latestSnapshotAt,
    snapshotTtlExpired,
    ttlDays,
    healthWarnings,
    seoManifest: {
      ...seoManifestStats,
      isStale: manifestIsStale,
    },
  };
}

function buildStorefrontDataHealthWarnings({
  latestSnapshotAt,
  snapshotTtlExpired,
  seoManifest,
  manifestIsStale,
}: {
  latestSnapshotAt: Date | null;
  snapshotTtlExpired: boolean;
  seoManifest: {
    generatedAt: string | null;
    missingPublishedProductIds: string[];
    missingCategorySlugs: string[];
    warnings: unknown[];
  };
  manifestIsStale: boolean;
}): StorefrontDataHealthWarning[] {
  const warnings: StorefrontDataHealthWarning[] = [];

  if (!latestSnapshotAt) {
    warnings.push({
      code: 'storefront_snapshot_missing',
      severity: 'critical',
      message: 'No storefront snapshot data is available.',
    });
  } else if (snapshotTtlExpired) {
    warnings.push({
      code: 'storefront_snapshot_ttl_expired',
      severity: 'warning',
      message: 'The latest storefront snapshot is older than the configured TTL.',
    });
  }

  if (!seoManifest.generatedAt) {
    warnings.push({
      code: 'seo_manifest_missing',
      severity: 'critical',
      message: 'The search metadata manifest is missing.',
    });
  } else if (manifestIsStale) {
    warnings.push({
      code: 'seo_manifest_stale',
      severity: 'warning',
      message: 'The search metadata manifest is older than the latest storefront snapshot.',
    });
  }

  if (seoManifest.missingPublishedProductIds.length || seoManifest.missingCategorySlugs.length) {
    warnings.push({
      code: 'seo_manifest_missing_coverage',
      severity: 'warning',
      message: 'The search metadata manifest is missing published product or category coverage.',
    });
  }

  if (seoManifest.warnings.length) {
    warnings.push({
      code: 'seo_manifest_warnings',
      severity: 'info',
      message: 'The latest search metadata generation reported warnings.',
    });
  }

  return warnings;
}

function maxDate(...dates: Array<Date | null>) {
  const timestamps = dates
    .map((date) => date?.getTime() ?? null)
    .filter((timestamp): timestamp is number => typeof timestamp === 'number');
  if (!timestamps.length) return null;

  return new Date(Math.max(...timestamps));
}

function isSnapshotTtlExpired(latestSnapshotAt: Date | null, ttlDays: string) {
  if (!latestSnapshotAt) return false;
  const days = Number(ttlDays);
  if (!Number.isFinite(days) || days < 0) return false;

  return Date.now() - latestSnapshotAt.getTime() > days * 24 * 60 * 60 * 1000;
}

function isSeoManifestStale(generatedAt: string | null, latestSnapshotAt: Date | null) {
  if (!generatedAt || !latestSnapshotAt) return false;

  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;

  return latestSnapshotAt.getTime() > generatedAtMs;
}

export async function runStorefrontMetadataDiagnosticsAction() {
  const admin = await requireAdminAction('shop.view');
  await writeAdminAuditLog({
    actor: admin,
    action: 'shop.storefront_data_health.metadata_diagnostics',
    outcome: 'started',
  });

  const productDiagnostics = await Promise.all(
    PUBLISHED_SHOP_PRODUCT_IDS.map((productId) => resolveProductMetadataDiagnostic(productId)),
  );
  const categoryDiagnostics = await Promise.all(
    STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.map((categorySlug) =>
      resolveCategoryMetadataDiagnostic(categorySlug),
    ),
  );
  const unknownDiagnostics = await Promise.all([
    resolveProductMetadataDiagnostic('__diagnostic_unknown_product__'),
    resolveCategoryMetadataDiagnostic('__diagnostic_unknown_category__'),
  ]);
  const checks = [
    {
      label: 'Published products resolve to indexable metadata',
      ok: productDiagnostics.every((item) => item.ok && item.shouldIndex),
      detail: `${productDiagnostics.filter((item) => item.ok && item.shouldIndex).length}/${productDiagnostics.length} published products covered.`,
    },
    {
      label: 'Configured categories resolve to indexable metadata',
      ok: categoryDiagnostics.every((item) => item.ok && item.shouldIndex),
      detail: `${categoryDiagnostics.filter((item) => item.ok && item.shouldIndex).length}/${categoryDiagnostics.length} categories covered.`,
    },
    {
      label: 'Unknown product returns noindex',
      ok:
        unknownDiagnostics[0]?.source === 'unknown_noindex' &&
        unknownDiagnostics[0]?.shouldIndex === false,
      detail: unknownDiagnostics[0]?.message ?? 'Unknown product diagnostic did not run.',
    },
    {
      label: 'Unknown category returns noindex',
      ok:
        unknownDiagnostics[1]?.source === 'unknown_noindex' &&
        unknownDiagnostics[1]?.shouldIndex === false,
      detail: unknownDiagnostics[1]?.message ?? 'Unknown category diagnostic did not run.',
    },
    {
      label: 'Diagnostics avoid live Merchize metadata calls',
      ok: [...productDiagnostics, ...categoryDiagnostics, ...unknownDiagnostics].every(
        (item) => item.source !== 'dev_live',
      ),
      detail: 'Resolved sources from manifest, snapshot, local fallback, or noindex only.',
    },
  ];
  const sourceCounts = countMetadataSources([
    ...productDiagnostics,
    ...categoryDiagnostics,
    ...unknownDiagnostics,
  ]);

  return {
    ok: checks.every((check) => check.ok),
    generatedAt: new Date().toISOString(),
    sourceCounts,
    checks,
    products: productDiagnostics,
    categories: categoryDiagnostics,
    unknown: unknownDiagnostics,
  };
}

async function resolveProductMetadataDiagnostic(
  productId: string,
): Promise<MetadataSourceDiagnostic> {
  const manifestEntry = await readProductSeoManifestEntry(productId).catch(() => null);
  if (manifestEntry) {
    return {
      targetKind: 'product',
      targetId: productId,
      source: 'manifest',
      shouldIndex: true,
      ok: true,
      message: 'Resolved from the search metadata manifest.',
    };
  }

  const snapshot = await getBasicProductFromSnapshot(productId).catch(() => null);
  if (snapshot) {
    return {
      targetKind: 'product',
      targetId: productId,
      source: 'snapshot',
      shouldIndex: true,
      ok: true,
      message: 'Resolved from local storefront snapshot.',
    };
  }

  const fallback = getPublishedShopProductPreview(productId);
  if (fallback) {
    return {
      targetKind: 'product',
      targetId: productId,
      source: 'published_fallback',
      shouldIndex: true,
      ok: true,
      message: 'Resolved from curated published product fallback.',
    };
  }

  return {
    targetKind: 'product',
    targetId: productId,
    source: 'unknown_noindex',
    shouldIndex: false,
    ok: true,
    message: 'Unknown product resolves to noindex metadata.',
  };
}

async function resolveCategoryMetadataDiagnostic(
  categorySlug: string,
): Promise<MetadataSourceDiagnostic> {
  const normalizedSlug = normalizeStorefrontCategorySlug(categorySlug);
  const manifestEntry = await readCategorySeoManifestEntry(normalizedSlug).catch(() => null);
  if (manifestEntry) {
    return {
      targetKind: 'category',
      targetId: normalizedSlug,
      source: 'manifest',
      shouldIndex: true,
      ok: true,
      message: 'Resolved from the search metadata manifest.',
    };
  }

  const snapshot = await getCategoryMetadataFromSnapshot(normalizedSlug).catch(() => null);
  if (snapshot) {
    return {
      targetKind: 'category',
      targetId: normalizedSlug,
      source: 'snapshot',
      shouldIndex: true,
      ok: true,
      message: 'Resolved from local storefront snapshot.',
    };
  }

  const publishedCategory = STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.some(
    (slug) => slug === normalizedSlug,
  );
  if (publishedCategory) {
    return {
      targetKind: 'category',
      targetId: normalizedSlug,
      source: 'category_fallback',
      shouldIndex: true,
      ok: true,
      message: 'Resolved from configured category fallback.',
    };
  }

  return {
    targetKind: 'category',
    targetId: normalizedSlug,
    source: 'unknown_noindex',
    shouldIndex: false,
    ok: true,
    message: 'Unknown category resolves to noindex metadata.',
  };
}

function countMetadataSources(items: MetadataSourceDiagnostic[]) {
  const counts: SourceCountMap = {
    manifest: 0,
    snapshot: 0,
    dev_live: 0,
    published_fallback: 0,
    category_fallback: 0,
    unknown_noindex: 0,
  };

  for (const item of items) {
    counts[item.source] += 1;
  }

  return counts;
}

export async function verifyPublishedProductsAction() {
  const admin = await requireAdminAction('shop.catalog.refresh');
  await writeAdminAuditLog({
    actor: admin,
    action: 'shop.storefront_data_health.verify_published_products',
    outcome: 'started',
    metadata: { products: PUBLISHED_SHOP_PRODUCT_IDS.length },
  });

  const checkedAt = new Date().toISOString();
  const products: PublishedProductVerificationItem[] = [];

  for (const productId of PUBLISHED_SHOP_PRODUCT_IDS) {
    products.push(await verifyPublishedProduct(productId));
  }

  const counts = products.reduce(
    (acc, product) => {
      acc[product.status] += 1;
      return acc;
    },
    {
      available: 0,
      missing_remote: 0,
      provider_error: 0,
    } satisfies Record<PublishedProductVerificationStatus, number>,
  );

  return {
    ok: counts.missing_remote === 0 && counts.provider_error === 0,
    checkedAt,
    counts,
    products,
  };
}

async function verifyPublishedProduct(
  productId: string,
): Promise<PublishedProductVerificationItem> {
  const expected = getPublishedShopProductPreview(productId);
  const expectedTitle = expected?.title ?? productId;
  const url = `${merchizeBaseURL}/product/products/${encodeURIComponent(productId)}`;

  try {
    const response = await fetchMerchizeJson<BasicProductInterface>(url, {
      headers: {
        'X-API-KEY': `${merchizeAPIKey}`,
      },
      cache: 'no-store',
    });

    const product = assertBasicStorefrontProductData(
      response.data,
      `Merchize product ${productId}`,
    );

    return {
      productId,
      expectedTitle,
      status: 'available',
      remoteTitle: product.title ?? null,
      message: 'Remote product is available.',
      statusCode: 200,
    };
  } catch (error) {
    const providerError = coerceMerchizeProviderError(error, url);
    if (providerError?.kind === 'not_found') {
      return {
        productId,
        expectedTitle,
        status: 'missing_remote',
        remoteTitle: null,
        message: 'Remote Merchize product returned not found.',
        statusCode: providerError.status,
      };
    }

    return {
      productId,
      expectedTitle,
      status: 'provider_error',
      remoteTitle: null,
      message: providerError?.message ?? (error instanceof Error ? error.message : String(error)),
      statusCode: providerError?.status ?? null,
    };
  }
}

export async function refreshPriceShippingCatalogAction() {
  try {
    const admin = await requireAdminAction('shop.catalog.refresh');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.catalog.refresh_price_shipping',
      outcome: 'started',
    });

    const result = await refreshMerchizeCatalog();
    const variantCompatibilityAudit = result.completedFullTraversal
      ? await runPublishedVariantCompatibilityAudit()
      : null;

    const syncState = await merchizeCatalogPrisma.syncState.findUnique({
      where: { id: 'merchize_catalog' },
    });

    revalidatePath('/admin/shop/storefront-data-health');
    revalidatePath('/admin/shop/storefront-data-health/variant-publication-issues');
    revalidatePath('/shop');

    return {
      ok: true as const,
      ingestedVariants: result.ingestedVariants,
      totalProducts: result.totalProducts,
      completedFullTraversal: result.completedFullTraversal,
      variantCompatibilityAudit,
      syncState,
    };
  } catch (e: unknown) {
    console.error('[MerchizeCatalog] refreshPriceShippingCatalogAction error', e);
    const message = e instanceof Error ? e.message : 'Unknown error while refreshing catalog';
    return {
      ok: false as const,
      error: getAdminActionErrorMessage(e, message),
    };
  }
}

export async function refreshStorefrontSnapshotsAction() {
  try {
    const admin = await requireAdminAction('shop.catalog.refresh');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.catalog.refresh_storefront_snapshots',
      outcome: 'started',
      metadata: { categories: STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.length },
    });

    const pageSize = 50;
    const failures: Array<{ category: string; message: string }> = [];
    const productSnapshotFailures: Array<{ productId: string; message: string }> = [];
    const categoryTotalPages = new Map<string, number>();
    const productIds = new Set<string>(PUBLISHED_SHOP_PRODUCT_IDS);
    let productsSeen = 0;
    let pagesFetched = 0;
    const refreshStartedAt = Date.now();

    console.info('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] start', {
      categories: STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.length,
      publishedProducts: PUBLISHED_SHOP_PRODUCT_IDS.length,
      pageSize,
    });

    for (const productId of PUBLISHED_SHOP_PRODUCT_IDS) {
      try {
        await fetchBaseProduct(productId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] product:failed', {
          productId,
          message,
        });

        productSnapshotFailures.push({
          productId,
          message,
        });
      }
    }

    for (const [index, category] of STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.entries()) {
      const categoryStartedAt = Date.now();
      let categoryProductsSeen = 0;
      let categoryPagesFetched = 0;

      console.info('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] category:start', {
        category,
        categoryNumber: index + 1,
        totalCategories: STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.length,
      });

      try {
        await getCategoryMetadataFromMerchize(category);
        const firstPage = await fetchCategoryProducts({
          category,
          page: 1,
          page_size: pageSize,
          forceSnapshotRefresh: true,
        });

        productsSeen += firstPage.products.length;
        categoryProductsSeen += firstPage.products.length;
        pagesFetched += 1;
        categoryPagesFetched += 1;
        categoryTotalPages.set(category, firstPage.totalPages);
        for (const product of firstPage.products) {
          if (product._id) productIds.add(product._id);
        }

        for (let page = 2; page <= firstPage.totalPages; page += 1) {
          const nextPage = await fetchCategoryProducts({
            category,
            page,
            page_size: pageSize,
            forceSnapshotRefresh: true,
          });
          productsSeen += nextPage.products.length;
          categoryProductsSeen += nextPage.products.length;
          pagesFetched += 1;
          categoryPagesFetched += 1;
          for (const product of nextPage.products) {
            if (product._id) productIds.add(product._id);
          }
        }

        console.info('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] category:complete', {
          category,
          pagesFetched: categoryPagesFetched,
          productsSeen: categoryProductsSeen,
          totalPages: firstPage.totalPages,
          totalProducts: firstPage.count,
          elapsedMs: Date.now() - categoryStartedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] category:failed', {
          category,
          message,
          elapsedMs: Date.now() - categoryStartedAt,
        });

        failures.push({
          category,
          message,
        });
      }
    }

    const seoManifest = await generateShopSeoManifest().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[shopSeoManifest.generate.afterSnapshotRefresh.failed]', { message });

      return {
        ok: false as const,
        activeGeneration: null,
        generatedAt: null,
        productCount: 0,
        categoryCount: 0,
        missingPublishedProductIds: [],
        missingCategorySlugs: [],
        manifestPath: '',
        retainedGenerationCount: 0,
        lastPrunedGenerationCount: 0,
        warnings: [],
        prunedGenerations: [],
        affectedRoutes: [],
        error: message,
      };
    });
    const variantCompatibilityAudit = await runPublishedVariantCompatibilityAudit([...productIds]);
    revalidatePath('/admin/shop/storefront-data-health');
    revalidatePath('/admin/shop/storefront-data-health/variant-publication-issues');
    const revalidatedPaths = revalidateStorefrontSnapshotPaths({
      categoryTotalPages,
      productIds,
      extraPaths: seoManifest.affectedRoutes,
    });
    const stats = await getStorefrontSnapshotStats();
    const result = {
      ok: failures.length === 0 && productSnapshotFailures.length === 0 && seoManifest.ok,
      productsSeen,
      pagesFetched,
      publishedProductsAttempted: PUBLISHED_SHOP_PRODUCT_IDS.length,
      productSnapshotFailures,
      categoriesAttempted: STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.length,
      failures,
      stats,
      seoManifest,
      variantCompatibilityAudit,
      revalidatedPaths,
    };

    console.info('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] complete', {
      ok: result.ok,
      categoriesAttempted: result.categoriesAttempted,
      pagesFetched: result.pagesFetched,
      productsSeen: result.productsSeen,
      publishedProductsAttempted: result.publishedProductsAttempted,
      failures: result.failures.map((failure) => failure.category),
      productSnapshotFailures: result.productSnapshotFailures.map((failure) => failure.productId),
      seoManifest: {
        ok: result.seoManifest.ok,
        productCount: result.seoManifest.productCount,
        categoryCount: result.seoManifest.categoryCount,
        missingPublishedProductIds: result.seoManifest.missingPublishedProductIds,
        missingCategorySlugs: result.seoManifest.missingCategorySlugs,
        prunedGenerations:
          'prunedGenerations' in result.seoManifest
            ? result.seoManifest.prunedGenerations.length
            : 0,
        warnings: result.seoManifest.warnings.length,
      },
      variantCompatibilityAudit:
        result.variantCompatibilityAudit.ok
          ? {
              ok: true,
              unavailableCount: result.variantCompatibilityAudit.unavailableCount,
              unverifiedCount: result.variantCompatibilityAudit.unverifiedCount,
              scanErrors: result.variantCompatibilityAudit.scanErrors.length,
            }
          : result.variantCompatibilityAudit,
      revalidatedPaths: result.revalidatedPaths.length,
      elapsedMs: Date.now() - refreshStartedAt,
    });

    return result;
  } catch (error) {
    const message = getAdminActionErrorMessage(error, 'Storefront snapshot refresh failed.');

    console.error('[merchizeCatalogSnapshots.refreshStorefrontSnapshots] failed', { message });

    return {
      ok: false as const,
      error: message,
      productsSeen: 0,
      pagesFetched: 0,
      publishedProductsAttempted: PUBLISHED_SHOP_PRODUCT_IDS.length,
      productSnapshotFailures: [],
      categoriesAttempted: STOREFRONT_SNAPSHOT_CATEGORY_SLUGS.length,
      failures: [],
      stats: await getStorefrontSnapshotStats().catch(() => getEmptyStorefrontSnapshotStats()),
      seoManifest: getFailedSeoManifestResult(message),
      variantCompatibilityAudit: {
        ok: false as const,
        error: 'Compatibility audit was not run because storefront snapshot refresh failed.',
      },
      revalidatedPaths: [],
    };
  }
}

function revalidateStorefrontSnapshotPaths({
  categoryTotalPages,
  productIds,
  extraPaths = [],
}: {
  categoryTotalPages: Map<string, number>;
  productIds: Set<string>;
  extraPaths?: string[];
}) {
  const paths = new Set<string>(['/shop', ...extraPaths]);

  for (const [category, totalPages] of categoryTotalPages) {
    const safeTotalPages = Math.max(1, totalPages);
    for (let page = 1; page <= safeTotalPages; page += 1) {
      paths.add(getCategoryPagePath(category, page));
    }
  }

  for (const productId of productIds) {
    paths.add(`/shop/product/${encodeURIComponent(productId)}`);
  }

  for (const path of paths) {
    revalidatePath(path);
  }

  return [...paths];
}

export async function generateShopSeoManifestAction() {
  try {
    const admin = await requireAdminAction('shop.catalog.refresh');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.catalog.generate_seo_manifest',
      outcome: 'started',
    });

    const result = await generateShopSeoManifest();
    const revalidatedPaths = revalidatePaths(result.affectedRoutes);
    const stats = await getStorefrontSnapshotStats();

    return {
      ...result,
      stats,
      revalidatedPaths,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[shopSeoManifest.generateAction.failed]', { message });

    return {
      ...getFailedSeoManifestResult(message),
      error: getAdminActionErrorMessage(error, message),
      stats: await getStorefrontSnapshotStats().catch(() => getEmptyStorefrontSnapshotStats()),
      revalidatedPaths: [],
    };
  }
}

function revalidatePaths(paths: string[]) {
  const uniquePaths = [...new Set(['/shop', ...paths])];

  for (const path of uniquePaths) {
    revalidatePath(path);
  }

  return uniquePaths;
}

export async function searchPriceShippingCatalogBySku(query: string) {
  const q = query.trim();
  if (!q) {
    return { ok: false as const, message: 'Enter a SKU or partial SKU' };
  }

  try {
    const admin = await requireAdminAction('shop.view');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.catalog.search_price_shipping_by_sku',
      targetType: 'skuQuery',
      targetId: q.slice(0, 128),
      outcome: 'started',
    });

    const variants = await merchizeCatalogPrisma.variant.findMany({
      where: { sku: { contains: q } }, // Prisma SQLite StringFilter: no `mode`
      include: { product: true, shippingBands: true },
      take: 10,
    });

    return { ok: true as const, variants };
  } catch (e: unknown) {
    console.error('[MerchizeCatalog] searchPriceShippingCatalogBySku error', e);
    const message = getAdminActionErrorMessage(e, 'Unknown error while searching catalog');
    return { ok: false as const, message };
  }
}
