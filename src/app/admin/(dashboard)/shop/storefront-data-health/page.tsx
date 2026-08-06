import type { Metadata } from 'next';
import StorefrontDataHealthAdminClient from './StorefrontDataHealthAdminClient';
import { getStorefrontSnapshotStats } from './actions';
import { getVariantPublicationIssueSummary } from './variantPublicationIssuesData';
import { merchizeCatalogPrisma } from '@/lib/prisma/shop/merchize/merchizeCatalogPrisma';
import { requireAdminPage } from '@/lib/admin/require-admin';

export const metadata: Metadata = {
  title: 'Storefront Data Health | Codex Christi Admin',
  description:
    'Shop admin tooling for Merchize catalog sync, storefront snapshots, and search metadata health.',
};

export const dynamic = 'force-dynamic';

async function getStorefrontDataHealthPageData() {
  try {
    const [
      syncState,
      sampleVariants,
      storefrontSnapshotStats,
      variantPublicationIssueSummary,
    ] = await Promise.all([
      merchizeCatalogPrisma.syncState.findUnique({
        where: { id: 'merchize_catalog' },
      }),
      merchizeCatalogPrisma.variant.findMany({
        include: { product: true, shippingBands: true },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      getStorefrontSnapshotStats(),
      getVariantPublicationIssueSummary(),
    ]);

    return {
      syncState,
      sampleVariants,
      storefrontSnapshotStats,
      variantPublicationIssueSummary,
    };
  } catch (error) {
    console.error('Failed to fetch storefront data health:', error);
    return null;
  }
}

export default async function StorefrontDataHealthAdminPage() {
  await requireAdminPage({
    scope: 'shop.view',
    returnPath: '/admin/shop/storefront-data-health',
  });

  const pageData = await getStorefrontDataHealthPageData();

  return (
    <>
      {pageData ? (
        <StorefrontDataHealthAdminClient
          initialSyncState={pageData.syncState}
          initialSamples={pageData.sampleVariants}
          initialStorefrontSnapshotStats={pageData.storefrontSnapshotStats}
          initialVariantPublicationIssueSummary={pageData.variantPublicationIssueSummary}
        />
      ) : (
        <div className='grid min-h-[60dvh] place-items-center px-4 text-white'>
          <div className='rounded-lg border border-rose-300/20 bg-rose-400/10 p-5 text-sm text-rose-100 supports-[backdrop-filter]:backdrop-blur-xl'>
            Error loading storefront data health.
          </div>
        </div>
      )}
    </>
  );
}
