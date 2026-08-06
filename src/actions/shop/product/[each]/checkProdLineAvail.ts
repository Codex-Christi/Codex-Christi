'use server';

import {
  resolveProviderStorefrontVariantCompatibility,
  type CurrentStorefrontVariantCompatibilityResult,
} from '@/lib/merchizeStorefront/currentProductLineCompatibility';

type LineCheckResult =
  | {
      ok: true;
      isAvailable: boolean;
      source: 'live';
      drift: null;
      compatibility: CurrentStorefrontVariantCompatibilityResult;
    }
  | {
      ok: false;
      isAvailable: false;
      source: 'live';
      drift: null;
      compatibility: CurrentStorefrontVariantCompatibilityResult | null;
    };

export async function checkProductLineAvail({
  storefrontProductId,
  storefrontVariantId,
}: {
  storefrontProductId: string;
  storefrontVariantId: string;
}): Promise<LineCheckResult> {
  try {
    const compatibility = await resolveProviderStorefrontVariantCompatibility(
      {
        storefrontProductId,
        storefrontVariantId,
      },
      { persist: true },
    );

    if (compatibility.status === 'unverified') {
      return {
        ok: false,
        isAvailable: false,
        source: 'live',
        drift: null,
        compatibility,
      };
    }

    return {
      ok: true,
      isAvailable: compatibility.status === 'available',
      source: 'live',
      drift: null,
      compatibility,
    };
  } catch (error) {
    console.error('[checkProductLineAvail] compatibility verification failed', error);
    return {
      ok: false,
      isAvailable: false,
      source: 'live',
      drift: null,
      compatibility: null,
    };
  }
}
