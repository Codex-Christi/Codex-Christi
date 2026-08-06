// src/lib/merchizeCatalog/sync.ts
import { merchizeCatalogPrisma } from '@/lib/prisma/shop/merchize/merchizeCatalogPrisma';
// 🔧 adjust this import path if your generated client lives elsewhere
import type { Prisma } from '../prisma/shop/merchize/generated/merchizeCatalog/client';
import { randomUUID } from 'node:crypto';

const CATALOG_URL = process.env.MERCHIZE_CATALOG_URL!;
const API_KEY = process.env.MERCHIZE_API_KEY!;

// --- API types ---------------------------------------------------------

export interface MerchizeTier {
  name: string; // usually "tier1" | "tier2" | "tier3"
  price: number | null;
}

export interface MerchizeShippingPrice {
  to_zone: string; // "US" | "EU" | "GB" | "CA" | "ROW" | ...
  to_country?: string; // "all" or specific country code, if present

  // Old field names (earlier API shape)
  first_item?: number | null;
  additional_item?: number | null;

  // New field names (current API shape)
  first_item_price?: number | null;
  additional_item_price?: number | null;
}

export interface MerchizeVariantAttribute {
  name: string;
  type: string;
  value_text: string;
  value_code: string;
}

export interface MerchizeVariant {
  _id: string;
  sku: string;
  attributes: MerchizeVariantAttribute[] | null;
  shipping_prices: MerchizeShippingPrice[] | null;
  tiers: MerchizeTier[] | null;
  artwork_positions: unknown | null;
}

export interface MerchizeProductAttributeValue {
  text: string;
  code: string;
}

export interface MerchizeProductAttribute {
  status: string;
  hide_on_storefront: boolean;
  customized: boolean;
  is_preselected: boolean;
  name: string;
  type: string;
  values: MerchizeProductAttributeValue[];
}

export interface MerchizeProductionTime {
  min: number;
  max: number;
}

export interface MerchizeFulfillmentLocation {
  name: string;
  code: string;
}

export interface MerchizeProduct {
  _id: string;
  variants: MerchizeVariant[] | null;
  attributes: MerchizeProductAttribute[] | null;
  production_time: MerchizeProductionTime | null;
  sku: string;
  slug: string;
  title: string;
  thumbnail_link: string;
  fulfillment_location: MerchizeFulfillmentLocation | null;
  mockup_and_templates_link: string | null;
  printing_methods: unknown[];
}

export interface MerchizeCatalogPage {
  success: boolean;
  data: {
    limit: number;
    page: number;
    total: number;
    products: MerchizeProduct[];
  };
}

// --- Small helpers -----------------------------------------------------

const SAFETY_MAX_PAGES = 10_000; // absolute hard stop
const SAFETY_MAX_VARIANTS = 100_000; // hard cap for variants ingested per run
const CATALOG_SYNC_STATE_ID = 'merchize_catalog';
const DEFAULT_CATALOG_SYNC_LEASE_MINUTES = 30;
export const CATALOG_SYNC_VARIANT_WRITE_BATCH_SIZE = 25;

export class MerchizeCatalogRefreshInProgressError extends Error {
  readonly code = 'MERCHIZE_CATALOG_REFRESH_IN_PROGRESS' as const;

  constructor() {
    super('A Merchize catalog refresh is already in progress.');
    this.name = 'MerchizeCatalogRefreshInProgressError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MerchizeCatalogRefreshLeaseLostError extends Error {
  readonly code = 'MERCHIZE_CATALOG_REFRESH_LEASE_LOST' as const;

  constructor() {
    super('The Merchize catalog refresh no longer owns its database lease.');
    this.name = 'MerchizeCatalogRefreshLeaseLostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createCatalogRefreshSingleFlight<T>(run: () => Promise<T>) {
  let active = false;
  return async () => {
    if (active) throw new MerchizeCatalogRefreshInProgressError();
    active = true;
    try {
      return await run();
    } finally {
      active = false;
    }
  };
}

export async function runCatalogLeaseFencedOperation<T>({
  renewLease,
  write,
}: {
  renewLease: () => Promise<boolean>;
  write: () => Promise<T>;
}) {
  if (!(await renewLease())) throw new MerchizeCatalogRefreshLeaseLostError();
  return write();
}

export function getCatalogGenerationCommitPolicy(completedFullTraversal: boolean) {
  return {
    markSeenRowsCurrent: completedFullTraversal,
    retireUnseenRows: completedFullTraversal,
    replaceCompletedGeneration: completedFullTraversal,
    invalidateCompletedGeneration: !completedFullTraversal,
  } as const;
}

export function buildShippingBandPruneWhere(variantId: string, currentZones: string[]) {
  return {
    variantId,
    ...(currentZones.length ? { toZone: { notIn: currentZones } } : {}),
  };
}

function catalogSyncLeaseMs() {
  const raw = process.env.MERCHIZE_CATALOG_SYNC_LEASE_MINUTES?.trim();
  const configured = raw ? Number(raw) : Number.NaN;
  const minutes = Number.isFinite(configured)
    ? Math.min(Math.max(configured, 5), 180)
    : DEFAULT_CATALOG_SYNC_LEASE_MINUTES;
  return minutes * 60 * 1_000;
}

async function acquireCatalogSyncLease(runId: string, startedAt: Date) {
  // Ensure the singleton row exists. The update branch is a deliberate no-op so the following
  // conditional update remains the atomic lease claim.
  await merchizeCatalogPrisma.syncState.upsert({
    where: { id: CATALOG_SYNC_STATE_ID },
    create: {
      id: CATALOG_SYNC_STATE_ID,
      lastRunAt: startedAt,
      activeRunId: runId,
      activeRunHeartbeatAt: startedAt,
    },
    update: { lastPage: { increment: 0 } },
  });

  const staleBefore = new Date(startedAt.getTime() - catalogSyncLeaseMs());
  const claim = await merchizeCatalogPrisma.syncState.updateMany({
    where: {
      id: CATALOG_SYNC_STATE_ID,
      OR: [
        { activeRunId: null },
        { activeRunId: runId },
        { activeRunHeartbeatAt: null },
        { activeRunHeartbeatAt: { lt: staleBefore } },
      ],
    },
    data: {
      activeRunId: runId,
      activeRunHeartbeatAt: startedAt,
      lastRunAt: startedAt,
    },
  });
  if (claim.count !== 1) throw new MerchizeCatalogRefreshInProgressError();
}

async function heartbeatCatalogSyncLease(runId: string) {
  const heartbeat = await merchizeCatalogPrisma.syncState.updateMany({
    where: { id: CATALOG_SYNC_STATE_ID, activeRunId: runId },
    data: { activeRunHeartbeatAt: new Date() },
  });
  if (heartbeat.count !== 1) throw new MerchizeCatalogRefreshLeaseLostError();
}

async function withCatalogSyncLeaseTransaction<T>(
  runId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  // The conditional lease renewal is the first write in the same SQLite transaction as the
  // bounded catalog mutation. A successor cannot take over between the fence and these writes.
  return merchizeCatalogPrisma.$transaction((tx) =>
    runCatalogLeaseFencedOperation({
      renewLease: async () => {
        const ownership = await tx.syncState.updateMany({
          where: { id: CATALOG_SYNC_STATE_ID, activeRunId: runId },
          data: { activeRunHeartbeatAt: new Date() },
        });
        return ownership.count === 1;
      },
      write: () => write(tx),
    }),
  );
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  // Prisma JSON inputs for optional fields should be either a valid JSON value or undefined.
  // Returning undefined lets Prisma treat it as "no change" / default null at the DB level,
  // which avoids the strict `NullableJsonNullValueInput` typing issues.
  if (value === null || value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}

function extractTierPrices(tiers: MerchizeTier[] | null | undefined) {
  const list = tiers ?? [];
  return {
    tier1: list.find((t) => t.name === 'tier1')?.price ?? null,
    tier2: list.find((t) => t.name === 'tier2')?.price ?? null,
    tier3: list.find((t) => t.name === 'tier3')?.price ?? null,
  };
}

// --- Fetch one page ----------------------------------------------------

async function fetchCatalogPage(
  page: number,
  limit = 50, // 🔧 default 50
): Promise<MerchizeCatalogPage> {
  if (!CATALOG_URL) {
    throw new Error('MERCHIZE_CATALOG_URL is not set');
  }
  if (!API_KEY) {
    throw new Error('MERCHIZE_API_KEY is not set');
  }

  // clamp to [1, 50] because API demands limit <= 50
  const safeLimit = Math.min(Math.max(limit, 1), 50);

  const url = new URL(CATALOG_URL);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(safeLimit));

  const res = await fetch(url.toString(), {
    headers: {
      'X-API-KEY': API_KEY,
    },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Merchize catalog API failed: ${res.status} ${res.statusText}${
        text ? ` - ${text.slice(0, 200)}` : ''
      }`,
    );
  }

  const json = (await res.json()) as MerchizeCatalogPage;
  if (!json.success || !json.data) {
    throw new Error('Merchize catalog API returned unsuccessful response');
  }

  return json;
}

// --- Per-product + per-variant upsert helpers --------------------------

async function upsertProduct(
  tx: Prisma.TransactionClient,
  product: MerchizeProduct,
  runId: string,
  observedAt: Date,
) {
  const merchizeProductId = String(product._id);

  const dataBase = {
    merchizeId: merchizeProductId,
    skuPrefix: product.sku ?? null,
    title: product.title ?? null,
    slug: product.slug ?? null,
    thumbUrl: product.thumbnail_link ?? null,
    fulfillCode: product.fulfillment_location?.code ?? null,
    fulfillName: product.fulfillment_location?.name ?? null,
    productionMin: product.production_time?.min ?? null,
    productionMax: product.production_time?.max ?? null,
    printingJson: toJsonValue(product.printing_methods ?? null),
    attributesJson: toJsonValue(product.attributes ?? null),
    mockupUrl: product.mockup_and_templates_link ?? null,
    catalogLastSeenRunId: runId,
    catalogLastSeenAt: observedAt,
  };

  return tx.product.upsert({
    where: { merchizeId: merchizeProductId },
    create: { ...dataBase, catalogCurrent: false },
    update: dataBase,
  });
}

async function upsertVariantAndBands(
  tx: Prisma.TransactionClient,
  productRecordId: string,
  variant: MerchizeVariant,
  runId: string,
  observedAt: Date,
) {
  const merchizeVariantId = String(variant._id);
  const { tier1, tier2, tier3 } = extractTierPrices(variant.tiers);

  const variantDataBase = {
    merchizeId: merchizeVariantId,
    sku: variant.sku,
    productId: productRecordId,
    attributesJson: toJsonValue(variant.attributes ?? null),
    tiersJson: toJsonValue(variant.tiers ?? null),
    tier1Price: tier1,
    tier2Price: tier2,
    tier3Price: tier3,
    catalogLastSeenRunId: runId,
    catalogLastSeenAt: observedAt,
  };

  const variantRecord = await tx.variant.upsert({
    where: { merchizeId: merchizeVariantId },
    create: { ...variantDataBase, catalogCurrent: false },
    update: variantDataBase,
  });

  const bands: MerchizeShippingPrice[] = variant.shipping_prices ?? [];
  const currentZones = [...new Set(bands.map((band) => band.to_zone).filter(Boolean))];
  for (const s of bands) {
    // Support both old (first_item/additional_item) and new (first_item_price/additional_item_price) field names.
    // Use null only when all candidates are undefined; keep 0 as a valid "free shipping" value.
    const first = s.first_item ?? s.first_item_price ?? null;
    const addl = s.additional_item ?? s.additional_item_price ?? null;

    await tx.shippingBand.upsert({
      where: {
        variantId_toZone: {
          variantId: variantRecord.id,
          toZone: s.to_zone,
        },
      },
      create: {
        variantId: variantRecord.id,
        toZone: s.to_zone,
        firstItem: first,
        addlItem: addl,
      },
      update: {
        firstItem: first,
        addlItem: addl,
      },
    });
  }

  // The variant payload is complete for its shipping zones. Remove zones no longer returned so a
  // historical band cannot remain positive P0.2 shipping evidence after a successful row refresh.
  await tx.shippingBand.deleteMany({
    where: buildShippingBandPruneWhere(variantRecord.id, currentZones),
  });

  return 1; // number of variants ingested
}

async function upsertProductWithLease(product: MerchizeProduct, runId: string, observedAt: Date) {
  return withCatalogSyncLeaseTransaction(runId, (tx) =>
    upsertProduct(tx, product, runId, observedAt),
  );
}

async function upsertVariantBatchWithLease({
  productRecordId,
  variants,
  runId,
  observedAt,
}: {
  productRecordId: string;
  variants: MerchizeVariant[];
  runId: string;
  observedAt: Date;
}) {
  // Keep the transaction bounded: it includes at most CATALOG_SYNC_VARIANT_WRITE_BATCH_SIZE
  // variants and their shipping bands, with a lease fence as its first statement.
  return withCatalogSyncLeaseTransaction(runId, async (tx) => {
    let ingested = 0;
    for (const variant of variants) {
      ingested += await upsertVariantAndBands(tx, productRecordId, variant, runId, observedAt);
    }
    return ingested;
  });
}

// --- Main sync ---------------------------------------------------------

async function runMerchizeCatalogRefresh() {
  const startedAt = new Date();
  const runId = randomUUID();
  let page = 1;
  let ingestedVariants = 0;
  let totalProducts = 0;
  let completedFullTraversal = false;
  let hitSafetyCap = false;

  await acquireCatalogSyncLease(runId, startedAt);

  // Simple log so you can see when a run starts in the server logs
  console.log('[MerchizeCatalog] Refresh started at', startedAt.toISOString());

  try {
    // loop over catalog pages until we reach the last page or safety caps
    while (page <= SAFETY_MAX_PAGES && ingestedVariants < SAFETY_MAX_VARIANTS) {
      const { data } = await fetchCatalogPage(page);
      const { products, total, page: currentPage, limit: pageLimit } = data;

      totalProducts = total;
      if (!products || products.length === 0) {
        console.log(`[MerchizeCatalog] No products found on page ${currentPage}, stopping sync.`);
        completedFullTraversal = total === 0 && currentPage === 1;
        break;
      }

      console.log(
        `[MerchizeCatalog] Page ${currentPage} of ~${Math.ceil(
          total / pageLimit,
        )} (${products.length} products, total=${total})`,
      );

      // Process this page's products sequentially to keep memory lower
      for (const product of products) {
        const observedAt = new Date();
        const productRecord = await upsertProductWithLease(product, runId, observedAt);
        const variants: MerchizeVariant[] = product.variants ?? [];

        for (
          let offset = 0;
          offset < variants.length && ingestedVariants < SAFETY_MAX_VARIANTS;
          offset += CATALOG_SYNC_VARIANT_WRITE_BATCH_SIZE
        ) {
          const remainingCapacity = SAFETY_MAX_VARIANTS - ingestedVariants;
          const batch = variants.slice(
            offset,
            offset + Math.min(CATALOG_SYNC_VARIANT_WRITE_BATCH_SIZE, remainingCapacity),
          );
          ingestedVariants += await upsertVariantBatchWithLease({
            productRecordId: productRecord.id,
            variants: batch,
            runId,
            observedAt,
          });
        }

        // Safety cap – bail out if we somehow hit a huge catalog
        if (ingestedVariants >= SAFETY_MAX_VARIANTS) {
          hitSafetyCap = true;
          console.warn(
            `[MerchizeCatalog] Reached SAFETY_MAX_VARIANTS (${SAFETY_MAX_VARIANTS}), aborting further ingestion.`,
          );
          break;
        }
      }

      await heartbeatCatalogSyncLease(runId);

      // compute if we have reached the last page
      const lastPage = Math.ceil(total / pageLimit);
      if (currentPage >= lastPage && !hitSafetyCap) {
        completedFullTraversal = true;
        console.log(`[MerchizeCatalog] Reached last page (${currentPage}/${lastPage}), stopping.`);
        break;
      }

      page += 1;
    }

    const now = new Date();
    const commitPolicy = getCatalogGenerationCommitPolicy(completedFullTraversal);
    if (commitPolicy.replaceCompletedGeneration) {
      await withCatalogSyncLeaseTransaction(runId, async (tx) => {
        await tx.variant.updateMany({
          where: { catalogLastSeenRunId: runId },
          data: { catalogCurrent: true, catalogRetiredAt: null },
        });
        await tx.product.updateMany({
          where: { catalogLastSeenRunId: runId },
          data: { catalogCurrent: true, catalogRetiredAt: null },
        });
        await tx.variant.updateMany({
          where: {
            catalogCurrent: true,
            OR: [{ catalogLastSeenRunId: null }, { catalogLastSeenRunId: { not: runId } }],
          },
          data: { catalogCurrent: false, catalogRetiredAt: now },
        });
        await tx.product.updateMany({
          where: {
            catalogCurrent: true,
            OR: [{ catalogLastSeenRunId: null }, { catalogLastSeenRunId: { not: runId } }],
          },
          data: { catalogCurrent: false, catalogRetiredAt: now },
        });
        await tx.syncState.update({
          where: { id: CATALOG_SYNC_STATE_ID },
          data: {
            lastPage: page,
            lastTotal: totalProducts,
            lastRunAt: now,
            lastSuccessAt: now,
            lastCompletedRunId: runId,
            lastCompletedAt: now,
            activeRunId: null,
            activeRunHeartbeatAt: null,
          },
        });
      });
    } else {
      // A partial/capped traversal never retires unseen rows. Because observed rows and shipping
      // bands were updated in place, however, the prior generation can no longer be positive
      // availability proof; invalidate it until a later full traversal succeeds.
      await withCatalogSyncLeaseTransaction(runId, async (tx) => {
        await tx.syncState.update({
          where: { id: CATALOG_SYNC_STATE_ID },
          data: {
            lastPage: page,
            lastTotal: totalProducts,
            lastRunAt: now,
            lastSuccessAt: now,
            lastCompletedRunId: null,
            lastCompletedAt: null,
            activeRunId: null,
            activeRunHeartbeatAt: null,
          },
        });
      });
    }

    console.log(
      `[MerchizeCatalog] Refresh completed: pagesProcessed=${page}, variants=${ingestedVariants}, totalProducts=${totalProducts}, complete=${completedFullTraversal}`,
    );

    return { ingestedVariants, totalProducts, completedFullTraversal, runId };
  } catch (err) {
    const now = new Date();
    console.error('[MerchizeCatalog] Refresh failed:', err);

    // still record that a run was attempted
    await merchizeCatalogPrisma.syncState.updateMany({
      where: { id: CATALOG_SYNC_STATE_ID, activeRunId: runId },
      data: {
        lastPage: page,
        lastTotal: totalProducts,
        lastRunAt: now,
        lastCompletedRunId: null,
        lastCompletedAt: null,
        activeRunId: null,
        activeRunHeartbeatAt: null,
      },
    });

    throw err;
  }
}

const runCatalogRefreshSingleFlight = createCatalogRefreshSingleFlight(runMerchizeCatalogRefresh);

export function refreshMerchizeCatalog() {
  return runCatalogRefreshSingleFlight();
}
