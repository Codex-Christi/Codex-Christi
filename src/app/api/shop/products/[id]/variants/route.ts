// app/api/shop/products/[id]/variants/route.ts
import { fetchCurrentProductVariantCompatibility } from '@/app/shop/product/[id]/productDetailsSSR';
import { merchizeErrorStatus } from '@/lib/merchizeStorefront/providerErrors';
import { NextResponse } from 'next/server';

type Params = Promise<{ id: string }>;

export async function GET(req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params; // ✅ await params
  void req;

  try {
    const compatibility = await fetchCurrentProductVariantCompatibility(id);
    const verificationIncomplete = compatibility.results.some(
      (result) => result.status === 'unverified',
    );

    if (verificationIncomplete && compatibility.sellableVariants.length === 0) {
      return NextResponse.json(
        { error: 'Product availability could not be verified. Please try again.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      );
    }

    return NextResponse.json(
      {
        data: compatibility.sellableVariants,
        verificationIncomplete,
      },
      {
        headers: {
          'Cache-Control': 'private, no-store',
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: merchizeErrorStatus(err) },
    );
  }
}
