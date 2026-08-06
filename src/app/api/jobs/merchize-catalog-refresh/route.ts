// src/app/api/jobs/merchize-catalog-refresh/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { refreshMerchizeCatalog } from '@/lib/merchizeCatalog/sync';
import { runPublishedVariantCompatibilityAudit } from '@/lib/merchizeStorefront/publishedVariantCompatibilityAudit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const cronSecret = process.env.MERCHIZE_OFFLINE_CATALOG_CRON_SECRET;
  const headerSecret = req.headers.get('x-cron-secret');

  if (!cronSecret || headerSecret !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await refreshMerchizeCatalog();
    const variantCompatibilityAudit = result.completedFullTraversal
      ? await runPublishedVariantCompatibilityAudit()
      : null;
    revalidatePath('/shop');
    revalidatePath('/admin/shop/storefront-data-health');
    return NextResponse.json({ ok: true, ...result, variantCompatibilityAudit });
  } catch (e: unknown) {
    console.error('Merchize refresh failed:', e);
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
