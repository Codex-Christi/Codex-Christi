'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ClipboardCheck,
  Database,
  FileText,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
} from 'lucide-react';
import AdminGlassPanel from '@/components/UI/Admin/dashboard/AdminGlassPanel';
import type {
  SyncState,
  Variant,
  Product,
  ShippingBand,
} from '@/lib/prisma/shop/merchize/generated/merchizeCatalog/client';
import {
  generateShopSeoManifestAction,
  refreshPriceShippingCatalogAction,
  refreshStorefrontSnapshotsAction,
  runStorefrontMetadataDiagnosticsAction,
  searchPriceShippingCatalogBySku,
  verifyPublishedProductsAction,
} from './actions';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/UI/primitives/alert-dialog';
import showErrorToast from '@/lib/error-toast';
import showSuccessToast from '@/lib/success-toast';
import showLoadingToast from '@/lib/loading-toast';
import { toast } from 'sonner';

type VariantWithRelations = Variant & {
  product: Product | null;
  shippingBands: ShippingBand[];
};

type Props = {
  initialSyncState: SyncState | null;
  initialSamples: VariantWithRelations[];
  initialStorefrontSnapshotStats: StorefrontSnapshotStats;
  initialVariantPublicationIssueSummary: {
    openIssueCount: number;
    unavailableIssueCount: number;
    unverifiedIssueCount: number;
    storageError: string | null;
  };
};

type StorefrontSnapshotStats = {
  productCount: number;
  categoryCount: number;
  variantSnapshotCount: number;
  lastProductSnapshotAt: Date | null;
  lastCategorySnapshotAt: Date | null;
  latestSnapshotAt: Date | null;
  snapshotTtlExpired: boolean;
  ttlDays: string;
  healthWarnings: Array<{ code: string; severity: string; message: string }>;
  seoManifest: {
    activeGeneration: string | null;
    generatedAt: string | null;
    productCount: number;
    categoryCount: number;
    missingPublishedProductIds: string[];
    missingCategorySlugs: string[];
    manifestPath: string;
    retainedGenerationCount: number;
    lastPrunedGenerationCount: number;
    warnings: Array<{ code: string; message: string }>;
    isStale: boolean;
  };
};

type MetadataDiagnosticsResult = Awaited<ReturnType<typeof runStorefrontMetadataDiagnosticsAction>>;

type PublishedProductVerificationResult = Awaited<ReturnType<typeof verifyPublishedProductsAction>>;

type StatusState =
  | { type: 'idle' }
  | { type: 'loading'; message: string }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

export default function StorefrontDataHealthAdminClient({
  initialSyncState,
  initialSamples,
  initialStorefrontSnapshotStats,
  initialVariantPublicationIssueSummary,
}: Props) {
  const router = useRouter();
  const [syncState, setSyncState] = useState<SyncState | null>(initialSyncState);
  const [storefrontSnapshotStats, setStorefrontSnapshotStats] = useState<StorefrontSnapshotStats>(
    initialStorefrontSnapshotStats,
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<VariantWithRelations[] | null>(null);
  const [metadataDiagnostics, setMetadataDiagnostics] = useState<MetadataDiagnosticsResult | null>(
    null,
  );
  const [publishedProductVerification, setPublishedProductVerification] =
    useState<PublishedProductVerificationResult | null>(null);
  const [status, setStatus] = useState<StatusState>({ type: 'idle' });
  const [isPending, startTransition] = useTransition();
  const [refreshProgress, setRefreshProgress] = useState(0);

  const working = isPending || status.type === 'loading';
  const list = searchResults ?? initialSamples;

  // Simple animated progress bar while "loading".
  useEffect(() => {
    if (status.type !== 'loading') return;

    const id = setInterval(() => {
      setRefreshProgress((pct) => Math.min(95, pct + 5));
    }, 400);

    return () => clearInterval(id);
  }, [status.type]);

  const handlePriceShippingRefreshConfirmed = () => {
    startTransition(async () => {
      setRefreshProgress(10);
      setStatus({ type: 'loading', message: 'Refreshing price and shipping catalog…' });
      const loadID1 = showLoadingToast({ message: 'Refreshing price and shipping catalog…' });

      try {
        const res = await refreshPriceShippingCatalogAction();
        toast.dismiss(loadID1);
        if (res.ok) {
          setSyncState(res.syncState ?? null);
          setRefreshProgress(100);
          const auditText = res.variantCompatibilityAudit
            ? res.variantCompatibilityAudit.ok
              ? ` Compatibility audit: ${res.variantCompatibilityAudit.unavailableCount} unavailable, ${res.variantCompatibilityAudit.unverifiedCount} unverified.`
              : ` Compatibility audit failed: ${res.variantCompatibilityAudit.error}`
            : ' Compatibility audit was deferred because the catalog traversal was incomplete.';
          const msg = `Refreshed. Variants: ${res.ingestedVariants}, products: ${res.totalProducts}.${auditText}`;
          setStatus({
            type: 'success',
            message: msg,
          });
          showSuccessToast({ header: 'Price and shipping catalog refreshed', message: msg });
          router.refresh();
        } else {
          setRefreshProgress(0);
          const msg = res.error ?? 'Refresh failed.';
          setStatus({
            type: 'error',
            message: msg,
          });
          showErrorToast?.({ header: 'Refresh failed', message: msg });
        }
      } catch (e: unknown) {
        toast.dismiss(loadID1);
        setRefreshProgress(0);
        const message = e instanceof Error ? e.message : 'Refresh failed.';
        setStatus({ type: 'error', message });
        showErrorToast?.({ header: 'Refresh error', message });
      }
    });
  };

  const handleStorefrontSnapshotsRefreshConfirmed = () => {
    startTransition(async () => {
      setRefreshProgress(10);
      setStatus({ type: 'loading', message: 'Refreshing storefront snapshots…' });
      const loadID = showLoadingToast({ message: 'Refreshing storefront snapshots…' });

      try {
        const res = await refreshStorefrontSnapshotsAction();
        toast.dismiss(loadID);
        setStorefrontSnapshotStats(res.stats);
        setRefreshProgress(100);

        const failureText = res.failures.length
          ? ` Failures: ${res.failures.map((failure) => failure.category).join(', ')}.`
          : '';
        const productFailureText = res.productSnapshotFailures.length
          ? ` Product snapshot failures: ${res.productSnapshotFailures
              .map((failure) => failure.productId)
              .join(', ')}.`
          : '';
        const revalidationText = res.revalidatedPaths.length
          ? ` Revalidated public paths: ${res.revalidatedPaths.length}.`
          : '';
        const seoManifestText = res.seoManifest.ok
          ? ` Search metadata manifest: ${res.seoManifest.productCount} products, ${res.seoManifest.categoryCount} categories.`
          : ` Search metadata manifest needs attention: ${res.seoManifest.productCount} products, ${res.seoManifest.categoryCount} categories.`;
        const seoManifestWarningText = res.seoManifest.warnings.length
          ? ` Search metadata warnings: ${res.seoManifest.warnings
              .map((warning) => warning.message)
              .join(' ')}`
          : '';
        const seoManifestPrunedText =
          'prunedGenerations' in res.seoManifest && res.seoManifest.prunedGenerations.length
            ? ` Pruned manifest generations: ${res.seoManifest.prunedGenerations.length}.`
            : '';
        const compatibilityText = res.variantCompatibilityAudit.ok
          ? ` Compatibility audit: ${res.variantCompatibilityAudit.unavailableCount} unavailable, ${res.variantCompatibilityAudit.unverifiedCount} unverified, ${res.variantCompatibilityAudit.scanErrors.length} provider errors.`
          : ` Compatibility audit failed: ${res.variantCompatibilityAudit.error}`;
        const msg = `Storefront snapshots refreshed. Pages: ${res.pagesFetched}, products seen: ${res.productsSeen}, published products attempted: ${res.publishedProductsAttempted}.${seoManifestText}${seoManifestPrunedText}${seoManifestWarningText}${revalidationText}${failureText}${productFailureText}${compatibilityText}`;

        setStatus({
          type: res.ok ? 'success' : 'error',
          message: msg,
        });

        if (res.ok) {
          showSuccessToast({ header: 'Storefront snapshots refreshed', message: msg });
        } else {
          showErrorToast({ header: 'Storefront snapshots partially failed', message: msg });
        }
        router.refresh();
      } catch (e: unknown) {
        toast.dismiss(loadID);
        setRefreshProgress(0);
        const message = e instanceof Error ? e.message : 'Storefront snapshot refresh failed.';
        setStatus({ type: 'error', message });
        showErrorToast({ header: 'Storefront snapshot refresh error', message });
      }
    });
  };

  const handleSeoManifestGenerateConfirmed = () => {
    startTransition(async () => {
      setRefreshProgress(10);
      setStatus({ type: 'loading', message: 'Generating search metadata manifest…' });
      const loadID = showLoadingToast({ message: 'Generating search metadata manifest…' });

      try {
        const res = await generateShopSeoManifestAction();
        toast.dismiss(loadID);
        setStorefrontSnapshotStats(res.stats);
        setRefreshProgress(100);

        const missingProductsText = res.missingPublishedProductIds.length
          ? ` Missing products: ${res.missingPublishedProductIds.join(', ')}.`
          : '';
        const missingCategoriesText = res.missingCategorySlugs.length
          ? ` Missing categories: ${res.missingCategorySlugs.join(', ')}.`
          : '';
        const errorText = 'error' in res && res.error ? ` ${res.error}` : '';
        const warningText = res.warnings.length
          ? ` Warnings: ${res.warnings.map((warning) => warning.message).join(' ')}`
          : '';
        const prunedText =
          'prunedGenerations' in res && res.prunedGenerations.length
            ? ` Pruned old generations: ${res.prunedGenerations.length}.`
            : '';
        const revalidationText = res.revalidatedPaths.length
          ? ` Revalidated public paths: ${res.revalidatedPaths.length}.`
          : '';
        const msg = `Search metadata manifest generated. Products: ${res.productCount}, categories: ${res.categoryCount}.${prunedText}${warningText}${revalidationText}${missingProductsText}${missingCategoriesText}${errorText}`;

        setStatus({
          type: res.ok ? 'success' : 'error',
          message: msg,
        });

        if (res.ok) {
          showSuccessToast({ header: 'Search metadata manifest generated', message: msg });
        } else {
          showErrorToast({ header: 'Search metadata manifest needs attention', message: msg });
        }
      } catch (e: unknown) {
        toast.dismiss(loadID);
        setRefreshProgress(0);
        const message =
          e instanceof Error ? e.message : 'Search metadata manifest generation failed.';
        setStatus({ type: 'error', message });
        showErrorToast({ header: 'Search metadata manifest generation error', message });
      }
    });
  };

  const handleMetadataDiagnosticsConfirmed = () => {
    startTransition(async () => {
      setRefreshProgress(10);
      setStatus({ type: 'loading', message: 'Running metadata diagnostics…' });
      const loadID = showLoadingToast({ message: 'Running metadata diagnostics…' });

      try {
        const res = await runStorefrontMetadataDiagnosticsAction();
        toast.dismiss(loadID);
        setMetadataDiagnostics(res);
        setRefreshProgress(100);

        const failedChecks = res.checks.filter((check) => !check.ok).length;
        const msg = `Metadata diagnostics complete. Checks: ${res.checks.length - failedChecks}/${res.checks.length} passed. Manifest hits: ${res.sourceCounts.manifest}, snapshot hits: ${res.sourceCounts.snapshot}, noindex: ${res.sourceCounts.unknown_noindex}.`;
        setStatus({ type: res.ok ? 'success' : 'error', message: msg });

        if (res.ok) {
          showSuccessToast({ header: 'Metadata diagnostics passed', message: msg });
        } else {
          showErrorToast({ header: 'Metadata diagnostics need review', message: msg });
        }
      } catch (e: unknown) {
        toast.dismiss(loadID);
        setRefreshProgress(0);
        const message = e instanceof Error ? e.message : 'Metadata diagnostics failed.';
        setStatus({ type: 'error', message });
        showErrorToast({ header: 'Metadata diagnostics error', message });
      }
    });
  };

  const handlePublishedProductVerificationConfirmed = () => {
    startTransition(async () => {
      setRefreshProgress(10);
      setStatus({ type: 'loading', message: 'Verifying published products…' });
      const loadID = showLoadingToast({ message: 'Verifying published products…' });

      try {
        const res = await verifyPublishedProductsAction();
        toast.dismiss(loadID);
        setPublishedProductVerification(res);
        setRefreshProgress(100);

        const msg = `Published product verification complete. Available: ${res.counts.available}, missing remote: ${res.counts.missing_remote}, provider errors: ${res.counts.provider_error}.`;
        setStatus({ type: res.ok ? 'success' : 'error', message: msg });

        if (res.ok) {
          showSuccessToast({ header: 'Published products verified', message: msg });
        } else {
          showErrorToast({ header: 'Published products need review', message: msg });
        }
      } catch (e: unknown) {
        toast.dismiss(loadID);
        setRefreshProgress(0);
        const message = e instanceof Error ? e.message : 'Published product verification failed.';
        setStatus({ type: 'error', message });
        showErrorToast({ header: 'Product verification error', message });
      }
    });
  };

  const handleSearch = () => {
    startTransition(async () => {
      setRefreshProgress(10);
      setStatus({ type: 'loading', message: 'Searching…' });
      const loadID2 = showLoadingToast({ message: 'Searching catalog…' });

      try {
        const res = await searchPriceShippingCatalogBySku(searchTerm);
        toast.dismiss(loadID2);
        if (res.ok) {
          setSearchResults(res.variants as VariantWithRelations[]);
          setRefreshProgress(100);
          const msg = `Found ${res.variants.length} result(s).`;
          setStatus({
            type: 'success',
            message: msg,
          });
          showSuccessToast?.({ header: 'Search complete', message: msg });
        } else {
          setRefreshProgress(0);
          const msg = res.message ?? 'Search failed.';
          setStatus({
            type: 'error',
            message: msg,
          });
          showErrorToast?.({ header: 'Search failed', message: msg });
        }
      } catch (e: unknown) {
        setRefreshProgress(0);
        const message = e instanceof Error ? e.message : 'Search failed.';
        setStatus({ type: 'error', message });
        showErrorToast({ header: 'Search error', message });
      }
    });
  };

  const lastRun = syncState?.lastRunAt ? new Date(syncState.lastRunAt).toLocaleString() : 'Never';

  const lastSuccess = syncState?.lastSuccessAt
    ? new Date(syncState.lastSuccessAt).toLocaleString()
    : 'Never';
  const snapshotTtlLabel = `${storefrontSnapshotStats.ttlDays} day${
    storefrontSnapshotStats.ttlDays === '1' ? '' : 's'
  }`;
  const lastProductSnapshot = formatAdminDate(storefrontSnapshotStats.lastProductSnapshotAt);
  const lastCategorySnapshot = formatAdminDate(storefrontSnapshotStats.lastCategorySnapshotAt);
  const lastSeoManifest = storefrontSnapshotStats.seoManifest.generatedAt
    ? formatAdminDate(new Date(storefrontSnapshotStats.seoManifest.generatedAt))
    : 'Never';
  const seoManifestMissingCount =
    storefrontSnapshotStats.seoManifest.missingPublishedProductIds.length +
    storefrontSnapshotStats.seoManifest.missingCategorySlugs.length;
  const seoManifestWarningCount = storefrontSnapshotStats.seoManifest.warnings.length;
  const criticalHealthWarnings = storefrontSnapshotStats.healthWarnings.filter(
    (warning) => warning.severity === 'critical',
  ).length;
  const warningHealthWarnings = storefrontSnapshotStats.healthWarnings.filter(
    (warning) => warning.severity === 'warning',
  ).length;
  const metadataCoverageStatus = !storefrontSnapshotStats.seoManifest.generatedAt
    ? 'Manifest missing'
    : storefrontSnapshotStats.seoManifest.isStale
      ? 'Manifest stale'
      : seoManifestMissingCount || seoManifestWarningCount || warningHealthWarnings
        ? 'Needs review'
        : 'Covered';
  const manifestFreshnessLabel = storefrontSnapshotStats.seoManifest.isStale ? 'Stale' : 'Current';
  const snapshotTtlStatus = storefrontSnapshotStats.snapshotTtlExpired ? 'Expired' : 'Current';

  const handleClearSearch = () => {
    setSearchTerm('');
    setSearchResults(null);
    setStatus({ type: 'idle' });
    setRefreshProgress(0);
  };

  return (
    <div className='space-y-5 px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4 sm:px-5'>
      <section className='grid gap-4 xl:grid-cols-[minmax(0,1fr)_430px]'>
        <AdminGlassPanel className='p-4 sm:p-5'>
          <p className='inline-flex rounded-md border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-cyan-100'>
            Merchize data plane
          </p>
          <h2 className='mt-4 text-xl font-semibold text-white'>Storefront data health</h2>
          <p className='mt-2 max-w-3xl text-sm leading-6 text-slate-400'>
            Refresh the local price/shipping catalog, storefront snapshots, and search metadata
            shards that keep public shop pages independent from live Merchize metadata calls.
          </p>

          <div className='mt-5 grid gap-3 text-xs sm:grid-cols-4'>
            <MiniStatus
              label='Catalog sync'
              value={lastSuccess === 'Never' ? 'Pending' : 'Ready'}
            />
            <MiniStatus label='Storefront TTL' value={snapshotTtlLabel} />
            <MiniStatus label='SQLite source' value='merchize_catalog' />
            <MiniStatus
              label='Search manifest'
              value={storefrontSnapshotStats.seoManifest.generatedAt ? 'Ready' : 'Missing'}
            />
          </div>
        </AdminGlassPanel>

        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-1'>
          <RefreshConfirmationDialog
            disabled={working}
            icon={<Database size={16} />}
            buttonText='Refresh price & shipping'
            helperText='SKU, variants, tiers, and shipping bands'
            title='Refresh price and shipping catalog?'
            description='This pulls all pages from the Merchize product-line catalog API and updates local price, SKU, variant, tier, and shipping data.'
            confirmText='Refresh price and shipping'
            onConfirm={handlePriceShippingRefreshConfirmed}
          />
          <RefreshConfirmationDialog
            disabled={working}
            icon={<Store size={16} />}
            buttonText='Refresh storefront snapshots'
            helperText='Category/product fallback and ISR paths'
            title='Refresh storefront snapshots?'
            description='This refreshes the category and product data used by public storefront pages when Merchize is unavailable, then revalidates the affected shop, category, and product pages.'
            confirmText='Refresh snapshots'
            onConfirm={handleStorefrontSnapshotsRefreshConfirmed}
          />
          <RefreshConfirmationDialog
            disabled={working}
            icon={<FileText size={16} />}
            buttonText='Generate search metadata'
            helperText='Product/category metadata shards'
            title='Generate search metadata manifest?'
            description='This derives small local search metadata shards from storefront snapshots, then revalidates affected public shop routes.'
            confirmText='Generate manifest'
            onConfirm={handleSeoManifestGenerateConfirmed}
          />
          <RefreshConfirmationDialog
            disabled={working}
            icon={<ClipboardCheck size={16} />}
            buttonText='Run metadata diagnostics'
            helperText='Source order, noindex, and coverage checks'
            title='Run metadata diagnostics?'
            description='This checks the local metadata read path for published products, configured categories, and unknown routes without calling live Merchize metadata APIs.'
            confirmText='Run diagnostics'
            onConfirm={handleMetadataDiagnosticsConfirmed}
          />
          <RefreshConfirmationDialog
            disabled={working}
            icon={<ShieldCheck size={16} />}
            buttonText='Verify published products'
            helperText='Manual remote existence check'
            title='Verify published products against Merchize?'
            description='This checks only the curated product IDs currently published by the storefront. It does not mutate snapshots or rebuild the search metadata manifest.'
            confirmText='Verify products'
            onConfirm={handlePublishedProductVerificationConfirmed}
          />
        </div>
      </section>

      {status.type === 'loading' && (
        <div
          className='h-1 w-full overflow-hidden rounded-full bg-slate-800'
          role='progressbar'
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={refreshProgress}
          aria-label={status.message}
        >
          <div
            className='h-full bg-cyan-300 transition-all duration-300 ease-out'
            style={{ width: `${refreshProgress}%` }}
          />
        </div>
      )}

      {status.type !== 'idle' && (
        <div
          role='status'
          aria-live='polite'
          className={`rounded-lg border px-3 py-2 text-xs transition ${
            status.type === 'success'
              ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
              : status.type === 'error'
                ? 'border-rose-500/60 bg-rose-500/10 text-rose-200'
                : 'border-slate-700 bg-slate-800 text-slate-200'
          }`}
        >
          {status.message}
        </div>
      )}

      <AdminGlassPanel className='p-4 sm:p-5'>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
          <div>
            <h2 className='text-base font-semibold text-white'>Metadata coverage</h2>
            <p className='mt-1 text-xs leading-5 text-slate-500'>
              The public metadata read path uses the search manifest first, then the SQLite
              snapshot, then local published fallbacks or noindex for unknown routes.
            </p>
          </div>
          <span className='inline-flex w-fit rounded-md border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-cyan-100'>
            {metadataCoverageStatus}
          </span>
        </div>

        <div className='mt-4 grid gap-3 text-xs sm:grid-cols-4'>
          <MiniStatus label='Primary metadata' value='Search manifest' />
          <MiniStatus label='Manifest age' value={lastSeoManifest} />
          <MiniStatus label='Manifest freshness' value={manifestFreshnessLabel} />
          <MiniStatus label='Snapshot TTL' value={snapshotTtlStatus} />
          <MiniStatus label='Missing coverage' value={String(seoManifestMissingCount)} />
          <MiniStatus label='Manifest warnings' value={String(seoManifestWarningCount)} />
          <MiniStatus label='Health warnings' value={String(warningHealthWarnings)} />
          <MiniStatus label='Critical warnings' value={String(criticalHealthWarnings)} />
        </div>

        {storefrontSnapshotStats.healthWarnings.length ? (
          <div className='mt-4 space-y-2'>
            {storefrontSnapshotStats.healthWarnings.map((warning) => (
              <div
                key={`${warning.code}-${warning.message}`}
                className='rounded-lg border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-xs text-amber-100'
              >
                <span className='font-semibold uppercase tracking-[0.12em]'>
                  {warning.severity}
                </span>{' '}
                {warning.message}
              </div>
            ))}
          </div>
        ) : null}
      </AdminGlassPanel>

      {metadataDiagnostics ? (
        <AdminGlassPanel className='p-4 sm:p-5'>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
            <div>
              <h2 className='text-base font-semibold text-white'>Metadata diagnostics</h2>
              <p className='mt-1 text-xs text-slate-500'>
                Last run: {formatAdminDate(metadataDiagnostics.generatedAt)}
              </p>
            </div>
            <span
              className={`inline-flex w-fit rounded-md border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${
                metadataDiagnostics.ok
                  ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100'
                  : 'border-amber-300/20 bg-amber-300/10 text-amber-100'
              }`}
            >
              {metadataDiagnostics.ok ? 'Passed' : 'Review'}
            </span>
          </div>

          <div className='mt-4 grid gap-3 text-xs sm:grid-cols-6'>
            <MiniStatus
              label='Manifest'
              value={String(metadataDiagnostics.sourceCounts.manifest)}
            />
            <MiniStatus
              label='Snapshot'
              value={String(metadataDiagnostics.sourceCounts.snapshot)}
            />
            <MiniStatus
              label='Published fallback'
              value={String(metadataDiagnostics.sourceCounts.published_fallback)}
            />
            <MiniStatus
              label='Category fallback'
              value={String(metadataDiagnostics.sourceCounts.category_fallback)}
            />
            <MiniStatus
              label='Noindex'
              value={String(metadataDiagnostics.sourceCounts.unknown_noindex)}
            />
            <MiniStatus
              label='Live calls'
              value={String(metadataDiagnostics.sourceCounts.dev_live)}
            />
          </div>

          <div className='mt-4 space-y-2'>
            {metadataDiagnostics.checks.map((check) => (
              <div
                key={check.label}
                className={`rounded-lg border px-3 py-2 text-xs ${
                  check.ok
                    ? 'border-emerald-300/20 bg-emerald-300/8 text-emerald-100'
                    : 'border-amber-300/20 bg-amber-300/8 text-amber-100'
                }`}
              >
                <span className='font-semibold'>{check.ok ? 'Pass' : 'Review'}:</span> {check.label}
                . {check.detail}
              </div>
            ))}
          </div>
        </AdminGlassPanel>
      ) : null}

      {publishedProductVerification ? (
        <AdminGlassPanel className='p-4 sm:p-5'>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
            <div>
              <h2 className='text-base font-semibold text-white'>Published product verification</h2>
              <p className='mt-1 text-xs text-slate-500'>
                Last run: {formatAdminDate(publishedProductVerification.checkedAt)}
              </p>
            </div>
            <span
              className={`inline-flex w-fit rounded-md border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${
                publishedProductVerification.ok
                  ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100'
                  : 'border-rose-300/20 bg-rose-300/10 text-rose-100'
              }`}
            >
              {publishedProductVerification.ok ? 'Verified' : 'Review'}
            </span>
          </div>

          <div className='mt-4 grid gap-3 text-xs sm:grid-cols-3'>
            <MiniStatus
              label='Available'
              value={String(publishedProductVerification.counts.available)}
            />
            <MiniStatus
              label='Missing remote'
              value={String(publishedProductVerification.counts.missing_remote)}
            />
            <MiniStatus
              label='Provider errors'
              value={String(publishedProductVerification.counts.provider_error)}
            />
          </div>

          {publishedProductVerification.products.some(
            (product) => product.status !== 'available',
          ) ? (
            <div className='mt-4 space-y-2'>
              {publishedProductVerification.products
                .filter((product) => product.status !== 'available')
                .map((product) => (
                  <div
                    key={product.productId}
                    className='rounded-lg border border-rose-300/20 bg-rose-300/8 px-3 py-2 text-xs text-rose-100'
                  >
                    <span className='font-mono text-[11px]'>{product.productId}</span>{' '}
                    {product.expectedTitle}: {product.message}
                  </div>
                ))}
            </div>
          ) : null}
        </AdminGlassPanel>
      ) : null}

      <div id='variant-compatibility-issues'>
        <AdminGlassPanel className='p-4 sm:p-5'>
          <div className='flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between'>
            <div>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 className='text-base font-semibold text-white'>Variant publication issues</h2>
                <span
                  className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                    initialVariantPublicationIssueSummary.storageError ||
                    initialVariantPublicationIssueSummary.openIssueCount
                      ? 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                      : 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100'
                  }`}
                >
                  {initialVariantPublicationIssueSummary.storageError
                    ? 'Counts unavailable'
                    : initialVariantPublicationIssueSummary.openIssueCount
                      ? `${initialVariantPublicationIssueSummary.openIssueCount} open`
                      : 'No open issues'}
                </span>
              </div>
              <p className='mt-1 max-w-2xl text-xs leading-5 text-slate-500'>
                Variants that cannot be matched safely to the current supplier catalog stay out of
                selection, cart additions, and checkout until repaired.
              </p>
            </div>

            <Link
              href='/admin/shop/storefront-data-health/variant-publication-issues'
              aria-label='Open detailed variant publication issue queue'
              className='inline-flex w-fit shrink-0 items-center gap-2 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:bg-cyan-300/15'
            >
              Review issue queue <ArrowRight size={13} aria-hidden='true' />
            </Link>
          </div>

          {!initialVariantPublicationIssueSummary.storageError ? (
            <dl className='mt-4 grid gap-3 text-xs sm:grid-cols-3'>
              <MiniStatus
                label='Open'
                value={String(initialVariantPublicationIssueSummary.openIssueCount)}
              />
              <MiniStatus
                label='Unavailable'
                value={String(initialVariantPublicationIssueSummary.unavailableIssueCount)}
              />
              <MiniStatus
                label='Unverified'
                value={String(initialVariantPublicationIssueSummary.unverifiedIssueCount)}
              />
            </dl>
          ) : null}

          {initialVariantPublicationIssueSummary.storageError ? (
            <p
              role='alert'
              className='mt-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2 text-xs leading-5 text-amber-100'
            >
              Variant compatibility storage is not ready, so issue counts are unavailable. Apply the
              additive Merchize catalog schema update and reload this page.
            </p>
          ) : null}
        </AdminGlassPanel>
      </div>

      <section className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        <StatTile label='Last catalog run' value={lastRun} />
        <StatTile label='Last successful sync' value={lastSuccess} />
        <StatTile label='Catalog total products' value={syncState?.lastTotal ?? 'Unknown'} />
        <StatTile label='Storefront products' value={storefrontSnapshotStats.productCount} />
        <StatTile label='Snapshot categories' value={storefrontSnapshotStats.categoryCount} />
        <StatTile label='Snapshot variants' value={storefrontSnapshotStats.variantSnapshotCount} />
        <StatTile label='Product snapshot' value={lastProductSnapshot} />
        <StatTile label='Category snapshot' value={lastCategorySnapshot} />
        <StatTile label='Snapshot TTL' value={snapshotTtlLabel} />
        <StatTile label='Search metadata manifest' value={lastSeoManifest} />
        <StatTile
          label='Product metadata shards'
          value={storefrontSnapshotStats.seoManifest.productCount}
        />
        <StatTile
          label='Category metadata shards'
          value={storefrontSnapshotStats.seoManifest.categoryCount}
        />
        <StatTile
          label='Products missing metadata'
          value={storefrontSnapshotStats.seoManifest.missingPublishedProductIds.length}
        />
        <StatTile
          label='Categories missing metadata'
          value={storefrontSnapshotStats.seoManifest.missingCategorySlugs.length}
        />
        <StatTile
          label='Retained manifest generations'
          value={storefrontSnapshotStats.seoManifest.retainedGenerationCount}
        />
        <StatTile
          label='Generations pruned last run'
          value={storefrontSnapshotStats.seoManifest.lastPrunedGenerationCount}
        />
      </section>

      <AdminGlassPanel className='overflow-hidden'>
        <div className='border-b border-white/10 px-4 py-3 sm:px-5'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <h2 className='text-base font-semibold text-white'>SKU lookup</h2>
              <p className='mt-1 text-xs text-slate-500'>
                Search the local price and shipping catalog without touching the public shop UI.
              </p>
            </div>
            {searchResults ? (
              <button
                type='button'
                onClick={handleClearSearch}
                className='rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 transition hover:border-cyan-300/30 hover:text-cyan-100'
              >
                Clear search
              </button>
            ) : null}
          </div>

          <div className='mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center'>
            <label htmlFor='merchize-sku-search' className='sr-only'>
              Search price and shipping catalog by SKU
            </label>
            <input
              id='merchize-sku-search'
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder='Search by full or partial SKU...'
              className='flex-1 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-300/20'
            />
            <button
              type='button'
              onClick={handleSearch}
              disabled={working || !searchTerm.trim()}
              aria-label='Search price and shipping catalog by SKU'
              className='inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-300/24 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-300/16 disabled:cursor-not-allowed disabled:opacity-50'
            >
              <Search size={14} aria-hidden='true' />
              Search
            </button>
          </div>
        </div>

        <div className='max-h-[28rem] overflow-auto p-3 sm:p-4'>
          <div className='mb-3 flex items-center justify-between text-xs text-slate-400'>
            <span>
              {searchResults
                ? `Search results (${list.length})`
                : `Latest sample variants (${list.length})`}
            </span>
          </div>
          <div className='space-y-2'>
            {list.map((v) => (
              <div
                key={v.id}
                className='rounded-lg border border-white/10 bg-slate-950/28 px-3 py-3 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
              >
                <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
                  <div className='min-w-0 space-y-1'>
                    <div className='font-mono text-[11px] text-emerald-300'>{v.sku}</div>
                    <div className='truncate text-sm font-medium text-slate-100'>
                      {v.product?.title ?? 'No title'}
                    </div>
                    <div className='text-slate-500'>
                      {v.product?.skuPrefix ?? v.product?.merchizeId}
                    </div>
                  </div>
                  <div className='flex flex-wrap gap-1.5'>
                    {v.shippingBands.slice(0, 4).map((b) => (
                      <span
                        key={b.id}
                        className='inline-flex items-center rounded-full border border-cyan-300/15 bg-cyan-300/[0.06] px-2 py-0.5 text-[10px] text-cyan-100'
                      >
                        {b.toZone}: {b.firstItem ?? '-'} / {b.addlItem ?? '-'}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {list.length === 0 && <div className='text-xs text-slate-500'>No data yet.</div>}
          </div>
        </div>
      </AdminGlassPanel>
    </div>
  );
}

function MiniStatus({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-lg border border-white/10 bg-white/[0.035] p-3'>
      <p className='text-slate-500'>{label}</p>
      <p className='mt-1 truncate font-medium text-slate-100'>{value}</p>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <AdminGlassPanel className='p-4'>
      <p className='text-xs text-slate-500'>{label}</p>
      <p className='mt-2 truncate text-sm font-semibold text-slate-100'>{value}</p>
    </AdminGlassPanel>
  );
}

function formatAdminDate(value: Date | string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function RefreshConfirmationDialog({
  disabled,
  icon,
  buttonText,
  helperText,
  title,
  description,
  confirmText,
  onConfirm,
}: {
  disabled: boolean;
  icon: ReactNode;
  buttonText: string;
  helperText: string;
  title: string;
  description: string;
  confirmText: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type='button'
          aria-label={buttonText}
          disabled={disabled}
          className='group relative flex min-h-[4.5rem] w-full items-center gap-3 overflow-hidden rounded-xl border border-blue-300/20 bg-blue-400/[0.075] px-4 py-3 text-left text-slate-100 shadow-[0_18px_46px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-cyan-200/42 hover:bg-blue-400/[0.12] hover:shadow-[0_20px_54px_rgba(14,165,233,0.14),inset_0_1px_0_rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-60 supports-[backdrop-filter]:backdrop-blur-xl'
        >
          <span className='pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-200/55 to-transparent opacity-80' />
          <span className='pointer-events-none absolute -right-10 -top-16 h-28 w-28 rounded-full bg-cyan-300/10 blur-2xl transition group-hover:bg-cyan-200/16' />
          {disabled ? (
            <span className='relative inline-flex items-center gap-3'>
              <RefreshCw className='h-4 w-4 animate-spin text-cyan-100' aria-hidden='true' />
              <span className='font-medium'>Working...</span>
            </span>
          ) : (
            <>
              <span className='relative grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-blue-200/28 bg-blue-200/10 text-cyan-100 shadow-[0_0_24px_rgba(59,130,246,0.14)]'>
                {icon}
              </span>
              <span className='relative min-w-0 flex-1'>
                <span className='block text-sm font-semibold'>{buttonText}</span>
                <span className='block text-[11px] text-slate-400'>{helperText}</span>
              </span>
              <span className='relative grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-cyan-200/18 bg-cyan-200/8 text-cyan-100 transition group-hover:translate-x-0.5 group-hover:border-cyan-200/35'>
                <ArrowRight size={15} />
              </span>
            </>
          )}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className='bg-slate-950/80 border border-slate-800 backdrop-blur-xl'>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
            <br />
            <br />
            Are you sure you want to continue?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className='bg-slate-900 border border-slate-700 hover:bg-slate-800'>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className='border border-cyan-300/24 bg-cyan-300/12 text-cyan-50 hover:bg-cyan-300/18'
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
