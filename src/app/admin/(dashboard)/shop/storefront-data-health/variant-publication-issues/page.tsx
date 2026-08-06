import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireAdminPage } from '@/lib/admin/require-admin';
import VariantPublicationIssuesPanel from '../VariantPublicationIssuesPanel';
import { getVariantPublicationIssueQueue } from '../variantPublicationIssuesData';

const ROUTE = '/admin/shop/storefront-data-health/variant-publication-issues';

type VariantPublicationIssuesAdminPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: 'Variant Publication Issues | Codex Christi Admin',
  description: 'Detailed Merchize variant publication compatibility incidents and repair evidence.',
};

export const dynamic = 'force-dynamic';

export default async function VariantPublicationIssuesAdminPage({
  searchParams,
}: VariantPublicationIssuesAdminPageProps) {
  const params = (await searchParams) ?? {};
  const requestedPage = getPositiveIntegerParam(params.page) ?? 1;
  await requireAdminPage({
    scope: 'shop.view',
    returnPath: ROUTE,
  });

  const queue = await getVariantPublicationIssueQueue(requestedPage);

  return (
    <div className='px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4 sm:px-5'>
      <section className='mx-auto max-w-[1600px] space-y-4' aria-labelledby='page-title'>
        <Link
          href='/admin/shop/storefront-data-health'
          aria-label='Return to storefront data health'
          className='inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-200 transition hover:border-cyan-300/30 hover:text-cyan-100'
        >
          <ArrowLeft size={14} aria-hidden='true' />
          Storefront data health
        </Link>

        <header>
          <p className='text-xs font-medium uppercase tracking-[0.16em] text-cyan-200'>
            Merchize catalog operations
          </p>
          <h2 id='page-title' className='mt-2 text-xl font-semibold text-white sm:text-2xl'>
            Variant publication issues
          </h2>
          <p className='mt-2 max-w-3xl text-sm leading-6 text-slate-400'>
            Review the complete manual-repair queue and the supplier evidence captured for each
            storefront variant. Catalog statistics and SKU lookup remain on the data-health page.
          </p>
        </header>

        <VariantPublicationIssuesPanel queue={queue} />
      </section>
    </div>
  );
}

function getPositiveIntegerParam(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
