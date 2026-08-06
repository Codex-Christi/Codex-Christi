import Link from 'next/link';
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import AdminGlassPanel from '@/components/UI/Admin/dashboard/AdminGlassPanel';
import CustomShopLink from '@/components/UI/Shop/HelperComponents/CustomShopLink';
import type { VariantPublicationIssueQueue } from './variantPublicationIssuesData';

type Props = {
  queue: VariantPublicationIssueQueue;
};

export default function VariantPublicationIssuesPanel({ queue }: Props) {
  return (
    <AdminGlassPanel className='overflow-hidden'>
      <div className='border-b border-white/10 px-4 py-4 sm:px-5'>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
          <div>
            <h2 className='text-base font-semibold text-white'>Variant publication issue queue</h2>
            <p className='mt-1 max-w-3xl text-xs leading-5 text-slate-500'>
              These storefront variants were returned by Merchize but could not be reconciled to one
              exact current production-line variant or a current supplier-catalog SKU. They are
              excluded from selection, cart additions, and checkout until repaired.
            </p>
          </div>
          <span
            className={`inline-flex w-fit rounded-md border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${
              queue.storageError || queue.openIssueCount
                ? 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                : 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100'
            }`}
          >
            {queue.storageError
              ? 'Counts unavailable'
              : queue.openIssueCount
                ? `${queue.openIssueCount} open`
                : 'No open issues'}
          </span>
        </div>

        {!queue.storageError ? (
          <dl className='mt-4 grid grid-cols-3 gap-2 text-xs sm:gap-3'>
            <IssueMetric label='Unavailable' value={queue.unavailableIssueCount} />
            <IssueMetric label='Unverified' value={queue.unverifiedIssueCount} />
            <IssueMetric label='Resolved' value={queue.recentlyResolvedIssues.length} />
          </dl>
        ) : null}
      </div>

      {queue.storageError ? (
        <div
          role='alert'
          className='border-b border-amber-300/15 bg-amber-300/[0.06] px-4 py-3 text-xs leading-5 text-amber-100 sm:px-5'
        >
          Variant compatibility storage could not be read, so publication incidents cannot be shown.
          Check the catalog database and additive schema update, then reload this page.
        </div>
      ) : null}

      {queue.openIssueCount ? (
        <p className='border-b border-white/10 px-4 py-2 text-[11px] text-slate-500 sm:px-5'>
          Showing {queue.pageStart}–{queue.pageEnd} of {queue.openIssueCount} open incidents, newest
          observations first.
        </p>
      ) : null}

      {queue.openIssues.length ? (
        <div className='divide-y divide-white/10'>
          {queue.openIssues.map((issue) => (
            <details key={issue.id} name='variant-publication-issue' className='group'>
              <summary className='cursor-pointer list-none px-4 py-2.5 outline-none transition hover:bg-white/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/50 sm:px-5 [&::-webkit-details-marker]:hidden'>
                <div className='grid min-w-0 gap-2 min-[480px]:grid-cols-[minmax(0,1.5fr)_minmax(11rem,1fr)] min-[480px]:items-center xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]'>
                  <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                          issue.status === 'unavailable'
                            ? 'border-rose-300/20 bg-rose-300/10 text-rose-100'
                            : 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                        }`}
                      >
                        {issue.status}
                      </span>
                      <span className='min-w-0 truncate font-mono text-[10px] text-slate-500'>
                        {issue.reasonCode}
                      </span>
                    </div>
                    <h3 className='mt-1.5 truncate text-sm font-semibold text-white'>
                      {issue.storefrontProductTitle || issue.storefrontProductId}
                    </h3>
                    <p className='mt-0.5 truncate text-xs leading-5 text-slate-400'>
                      {formatVariantCompatibilityOptions(issue.selectedOptionsJson)}
                    </p>
                  </div>

                  <div className='flex min-w-0 flex-wrap items-end gap-x-4 gap-y-1 min-[480px]:justify-end xl:contents'>
                    <SummaryDetail
                      label='Storefront SKU'
                      value={issue.storefrontSku || 'Unavailable'}
                      mono
                      className='max-w-full flex-1 min-[480px]:flex-none'
                    />
                    <SummaryDetail
                      label='Last observed'
                      value={formatAdminDate(issue.lastObservedAt)}
                      className='hidden lg:block'
                    />
                    <SummaryDetail
                      label='Occurrences'
                      value={`${issue.occurrenceCount} · episode ${issue.incidentEpisode}`}
                    />
                    <span className='ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-cyan-100 min-[480px]:ml-0'>
                      Evidence
                      <ChevronDown
                        size={14}
                        aria-hidden='true'
                        className='shrink-0 transition-transform group-open:rotate-180'
                      />
                    </span>
                  </div>
                </div>
              </summary>

              <div className='border-t border-white/10 bg-slate-950/20 px-4 py-4 sm:px-5'>
                <dl className='grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4'>
                  <CompatibilityDetail label='Product ID' value={issue.storefrontProductId} mono />
                  <CompatibilityDetail label='Variant ID' value={issue.storefrontVariantId} mono />
                  <CompatibilityDetail
                    label='Matched supplier SKU'
                    value={issue.supplierSku || 'No exact match'}
                    mono
                  />
                  <CompatibilityDetail
                    label='Matched supplier product ID'
                    value={issue.supplierProductId || 'No exact match'}
                    mono
                  />
                  <CompatibilityDetail
                    label='Matched supplier variant ID'
                    value={issue.supplierVariantId || 'No exact match'}
                    mono
                  />
                  <CompatibilityDetail
                    label='Configured product line'
                    value={issue.productLineName || 'Unavailable'}
                    className='sm:col-span-2'
                  />
                  <CompatibilityDetail
                    label='First observed'
                    value={formatAdminDate(issue.firstObservedAt)}
                  />
                  <CompatibilityDetail
                    label='Provider evidence'
                    value={formatVariantCompatibilityEvidence(issue.providerEvidenceJson)}
                    className='sm:col-span-2 xl:col-span-4'
                  />
                </dl>

                <div className='mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between'>
                  <p className='rounded-lg border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-xs leading-5 text-amber-100'>
                    In Merchize, remap this storefront variant to one exact current product-line
                    variant, or delete the obsolete storefront variant. If the supplier identity
                    changed intentionally, refresh price and shipping before rechecking. Do not
                    auto-apply a fuzzy or suggested replacement.
                  </p>
                  <CustomShopLink
                    href={`/shop/product/${encodeURIComponent(issue.storefrontProductId)}`}
                    ariaLabel={`Open storefront product ${
                      issue.storefrontProductTitle || issue.storefrontProductId
                    }`}
                    className='inline-flex w-fit shrink-0 items-center gap-1 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:bg-cyan-300/15'
                  >
                    Open storefront product <ArrowRight size={13} aria-hidden='true' />
                  </CustomShopLink>
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : !queue.storageError ? (
        <p className='px-4 py-5 text-sm text-slate-400 sm:px-5'>
          No storefront variant currently needs manual catalog repair.
        </p>
      ) : null}

      {!queue.storageError && queue.totalPages > 1 ? (
        <IssueQueuePagination currentPage={queue.currentPage} totalPages={queue.totalPages} />
      ) : null}

      {queue.recentlyResolvedIssues.length ? (
        <details className='border-t border-white/10 px-4 py-4 sm:px-5'>
          <summary className='cursor-pointer text-xs font-medium text-slate-300'>
            Recently resolved ({queue.recentlyResolvedIssues.length})
          </summary>
          <div className='mt-3 space-y-2'>
            {queue.recentlyResolvedIssues.map((issue) => (
              <div
                key={issue.id}
                className='rounded-lg border border-emerald-300/15 bg-emerald-300/5 px-3 py-2 text-xs text-emerald-100'
              >
                {issue.storefrontProductTitle || issue.storefrontProductId} ·{' '}
                <span className='font-mono'>
                  {issue.storefrontSku || issue.storefrontVariantId}
                </span>{' '}
                · resolved {formatAdminDate(issue.resolvedAt)}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </AdminGlassPanel>
  );
}

const ISSUE_QUEUE_ROUTE = '/admin/shop/storefront-data-health/variant-publication-issues';

function IssueQueuePagination({
  currentPage,
  totalPages,
}: {
  currentPage: number;
  totalPages: number;
}) {
  return (
    <nav
      aria-label='Variant publication issue pages'
      className='flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs sm:px-5'
    >
      {currentPage > 1 ? (
        <Link
          href={`${ISSUE_QUEUE_ROUTE}?page=${currentPage - 1}`}
          className='inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-medium text-slate-200 transition hover:border-cyan-300/30 hover:text-cyan-100'
        >
          <ChevronLeft size={14} aria-hidden='true' />
          Previous
        </Link>
      ) : (
        <span className='inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/5 px-3 py-2 text-slate-600'>
          <ChevronLeft size={14} aria-hidden='true' />
          Previous
        </span>
      )}

      <span className='text-center text-slate-400'>
        Page {currentPage} of {totalPages}
      </span>

      {currentPage < totalPages ? (
        <Link
          href={`${ISSUE_QUEUE_ROUTE}?page=${currentPage + 1}`}
          className='inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-medium text-slate-200 transition hover:border-cyan-300/30 hover:text-cyan-100'
        >
          Next
          <ChevronRight size={14} aria-hidden='true' />
        </Link>
      ) : (
        <span className='inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/5 px-3 py-2 text-slate-600'>
          Next
          <ChevronRight size={14} aria-hidden='true' />
        </span>
      )}
    </nav>
  );
}

function formatVariantCompatibilityOptions(value: unknown) {
  const options = Array.isArray(value)
    ? value
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const option = entry as Record<string, unknown>;
          const name = typeof option.name === 'string' ? option.name.trim() : '';
          const optionValue = typeof option.value === 'string' ? option.value.trim() : '';
          return name && optionValue ? `${name}: ${optionValue}` : null;
        })
        .filter((entry): entry is string => Boolean(entry))
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>)
          .map(([name, optionValue]) =>
            typeof optionValue === 'string' && optionValue.trim()
              ? `${name}: ${optionValue.trim()}`
              : null,
          )
          .filter((entry): entry is string => Boolean(entry))
      : [];

  return options.length ? options.join(' · ') : 'No normalized option evidence was recorded.';
}

function formatVariantCompatibilityEvidence(value: unknown) {
  if (!value || typeof value !== 'object') return 'No additional provider evidence was recorded.';

  const evidence = value as Record<string, unknown>;
  const presetSupplierIdentity = formatSupplierIdentityEvidence(evidence.presetSupplierIdentity);
  const hasCurrentCatalogIdentity = Object.prototype.hasOwnProperty.call(
    evidence,
    'currentCatalogIdentity',
  );
  const currentCatalogIdentity = formatSupplierIdentityEvidence(evidence.currentCatalogIdentity);
  const candidateRecords = [evidence.currentCandidateSample, evidence.ambiguousCandidates]
    .flatMap((candidateList) => (Array.isArray(candidateList) ? candidateList : []))
    .filter((candidate): candidate is Record<string, unknown> =>
      Boolean(candidate && typeof candidate === 'object'),
    )
    .slice(0, 12);
  const candidateSummaries = candidateRecords.map((candidate) => {
    const sku = typeof candidate.supplierSku === 'string' ? candidate.supplierSku : 'SKU missing';
    const options = formatVariantCompatibilityOptions(candidate.selectedOptions);
    return `${sku} (${options})`;
  });
  const storefrontOptions = Array.isArray(evidence.storefrontOptions)
    ? evidence.storefrontOptions
        .filter((option): option is Record<string, unknown> =>
          Boolean(option && typeof option === 'object'),
        )
        .slice(0, 16)
        .map((option) => {
          const name =
            (typeof option.attributeName === 'string' && option.attributeName) ||
            (typeof option.attributeType === 'string' && option.attributeType) ||
            'option';
          const optionValue =
            (typeof option.name === 'string' && option.name) ||
            (typeof option.value === 'string' && option.value) ||
            (typeof option.slug === 'string' && option.slug) ||
            'value unavailable';
          return `${name}: ${optionValue}`;
        })
    : [];
  const details = [
    typeof evidence.candidateCount === 'number' ? `Candidates: ${evidence.candidateCount}` : null,
    typeof evidence.returnedPresetCount === 'number'
      ? `Search presets returned: ${evidence.returnedPresetCount}`
      : null,
    typeof evidence.exactProductLinePresetCount === 'number'
      ? `Exact product lines: ${evidence.exactProductLinePresetCount}`
      : null,
    typeof evidence.currentProductLineVariantCount === 'number'
      ? `Current line variants checked: ${evidence.currentProductLineVariantCount}`
      : null,
    presetSupplierIdentity ? `Product-line identity: ${presetSupplierIdentity}` : null,
    hasCurrentCatalogIdentity
      ? `Completed catalog identity: ${currentCatalogIdentity || 'no matching SKU row'}`
      : null,
    storefrontOptions.length ? `Storefront options: ${storefrontOptions.join(', ')}` : null,
    candidateSummaries.length ? `Current candidate sample: ${candidateSummaries.join('; ')}` : null,
    evidence.currentCandidateSampleTruncated === true ||
    evidence.ambiguousCandidatesTruncated === true
      ? 'Candidate sample truncated'
      : null,
  ].filter((detail): detail is string => Boolean(detail));

  return details.length ? details.join(' · ') : 'No additional provider evidence was recorded.';
}

function formatSupplierIdentityEvidence(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const identity = value as Record<string, unknown>;
  const productId =
    typeof identity.supplierProductId === 'string' ? identity.supplierProductId : '';
  const variantId =
    typeof identity.supplierVariantId === 'string' ? identity.supplierVariantId : '';
  const sku = typeof identity.supplierSku === 'string' ? identity.supplierSku : '';
  const parts = [
    sku ? `SKU ${sku}` : null,
    productId ? `product ${productId}` : null,
    variantId ? `variant ${variantId}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(', ') : null;
}

function CompatibilityDetail({
  label,
  value,
  mono = false,
  className = '',
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border border-white/10 bg-slate-950/30 px-3 py-2 ${className}`}
    >
      <dt className='text-[10px] uppercase tracking-[0.12em] text-slate-500'>{label}</dt>
      <dd className={`mt-1 break-words text-slate-200 ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function SummaryDetail({
  label,
  value,
  mono = false,
  className = '',
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span className={`min-w-0 ${className}`}>
      <span className='block text-[10px] uppercase tracking-[0.12em] text-slate-500'>{label}</span>
      <span
        className={`mt-1 block break-words text-xs text-slate-200 ${
          mono ? 'font-mono text-[11px]' : ''
        }`}
      >
        {value}
      </span>
    </span>
  );
}

function IssueMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-lg border border-white/10 bg-white/[0.035] p-3'>
      <dt className='text-slate-500'>{label}</dt>
      <dd className='mt-1 truncate font-medium text-slate-100'>{value}</dd>
    </div>
  );
}

function formatAdminDate(value: Date | string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}
