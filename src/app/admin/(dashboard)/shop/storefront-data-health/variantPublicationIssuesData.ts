import 'server-only';

import type { Prisma } from '@/lib/prisma/shop/merchize/generated/merchizeCatalog/client';
import { merchizeCatalogPrisma } from '@/lib/prisma/shop/merchize/merchizeCatalogPrisma';

const OPEN_VARIANT_PUBLICATION_STATUSES = ['unavailable', 'unverified'] as const;
const VARIANT_PUBLICATION_ISSUE_PAGE_SIZE = 50;

const variantPublicationIssueSelect = {
  id: true,
  storefrontProductId: true,
  storefrontVariantId: true,
  storefrontProductTitle: true,
  storefrontSku: true,
  supplierProductId: true,
  supplierVariantId: true,
  supplierSku: true,
  productLineName: true,
  selectedOptionsJson: true,
  providerEvidenceJson: true,
  status: true,
  reasonCode: true,
  occurrenceCount: true,
  incidentEpisode: true,
  firstObservedAt: true,
  lastObservedAt: true,
  resolvedAt: true,
} satisfies Prisma.StorefrontVariantCompatibilitySelect;

export type VariantPublicationIssue = Prisma.StorefrontVariantCompatibilityGetPayload<{
  select: typeof variantPublicationIssueSelect;
}>;

export type VariantPublicationIssueSummary = {
  openIssueCount: number;
  unavailableIssueCount: number;
  unverifiedIssueCount: number;
  storageError: string | null;
};

export type VariantPublicationIssueQueue = VariantPublicationIssueSummary & {
  openIssues: VariantPublicationIssue[];
  recentlyResolvedIssues: VariantPublicationIssue[];
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pageStart: number;
  pageEnd: number;
};

async function getIssueCounts() {
  const statusCounts = await merchizeCatalogPrisma.storefrontVariantCompatibility.groupBy({
    by: ['status'],
    where: { status: { in: [...OPEN_VARIANT_PUBLICATION_STATUSES] } },
    _count: { _all: true },
  });
  const unavailableIssueCount =
    statusCounts.find(({ status }) => status === 'unavailable')?._count._all ?? 0;
  const unverifiedIssueCount =
    statusCounts.find(({ status }) => status === 'unverified')?._count._all ?? 0;

  return {
    openIssueCount: unavailableIssueCount + unverifiedIssueCount,
    unavailableIssueCount,
    unverifiedIssueCount,
  };
}

function unavailableSummary(): VariantPublicationIssueSummary {
  return {
    openIssueCount: 0,
    unavailableIssueCount: 0,
    unverifiedIssueCount: 0,
    storageError: 'Variant compatibility storage is unavailable.',
  };
}

export async function getVariantPublicationIssueSummary(): Promise<VariantPublicationIssueSummary> {
  try {
    const counts = await getIssueCounts();

    return {
      ...counts,
      storageError: null,
    };
  } catch (error) {
    console.error('Failed to fetch storefront variant publication issue summary:', error);
    return unavailableSummary();
  }
}

export async function getVariantPublicationIssueQueue(
  requestedPage = 1,
): Promise<VariantPublicationIssueQueue> {
  try {
    const counts = await getIssueCounts();
    const totalPages = Math.max(
      1,
      Math.ceil(counts.openIssueCount / VARIANT_PUBLICATION_ISSUE_PAGE_SIZE),
    );
    const normalizedRequestedPage =
      Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const currentPage = Math.min(normalizedRequestedPage, totalPages);
    const [openIssues, recentlyResolvedIssues] = await Promise.all([
      merchizeCatalogPrisma.storefrontVariantCompatibility.findMany({
        where: { status: { in: [...OPEN_VARIANT_PUBLICATION_STATUSES] } },
        select: variantPublicationIssueSelect,
        orderBy: [{ lastObservedAt: 'desc' }, { id: 'desc' }],
        skip: (currentPage - 1) * VARIANT_PUBLICATION_ISSUE_PAGE_SIZE,
        take: VARIANT_PUBLICATION_ISSUE_PAGE_SIZE,
      }),
      merchizeCatalogPrisma.storefrontVariantCompatibility.findMany({
        where: { status: 'resolved', resolvedAt: { not: null } },
        select: variantPublicationIssueSelect,
        orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
    ]);
    const pageStart = counts.openIssueCount
      ? (currentPage - 1) * VARIANT_PUBLICATION_ISSUE_PAGE_SIZE + 1
      : 0;
    const pageEnd = Math.min(
      currentPage * VARIANT_PUBLICATION_ISSUE_PAGE_SIZE,
      counts.openIssueCount,
    );

    return {
      openIssues,
      recentlyResolvedIssues,
      ...counts,
      storageError: null,
      currentPage,
      totalPages,
      pageSize: VARIANT_PUBLICATION_ISSUE_PAGE_SIZE,
      pageStart,
      pageEnd,
    };
  } catch (error) {
    console.error('Failed to fetch storefront variant publication issue queue:', error);
    return {
      ...unavailableSummary(),
      openIssues: [],
      recentlyResolvedIssues: [],
      currentPage: 1,
      totalPages: 1,
      pageSize: VARIANT_PUBLICATION_ISSUE_PAGE_SIZE,
      pageStart: 0,
      pageEnd: 0,
    };
  }
}
