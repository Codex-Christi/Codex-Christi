import { NextResponse } from 'next/server';
import { getMerchizeTotalWIthShipping } from '@/actions/merchize/getMerchizeTotalWithShipping';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import { hydrateCartDisplayFromMerchizeOfflineCatalog } from '@/actions/shop/cart/hydrateCartDisplayFromMerchizeOfflineCatalog';
import { hasCheckoutBlockingCartItems } from '@/components/UI/Shop/Cart/cartAvailability';

type ShippingEstimatePayload = {
  cart: CartVariant[];
  countryIso3: string;
  stateIso2?: string | null;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<ShippingEstimatePayload>;
    const cart = Array.isArray(body?.cart) ? (body.cart as CartVariant[]) : [];
    const countryIso3 =
      typeof body?.countryIso3 === 'string' && body.countryIso3.length === 3
        ? body.countryIso3
        : null;

    if (!countryIso3 || !cart.length) {
      return NextResponse.json(
        { success: false, error: 'Missing cart or country ISO3.' },
        { status: 400 },
      );
    }

    const stateIso2 =
      typeof body?.stateIso2 === 'string' && body.stateIso2.length > 0 ? body.stateIso2 : undefined;

    const normalizedIso3 = countryIso3.toUpperCase();
    const verifiedCart = await hydrateCartDisplayFromMerchizeOfflineCatalog(cart);
    if (hasCheckoutBlockingCartItems(cart, verifiedCart.availabilityByVariantId)) {
      return NextResponse.json(
        { success: false, error: 'One or more cart variants are unavailable or unverified.' },
        { status: 409 },
      );
    }

    const totals = await getMerchizeTotalWIthShipping(verifiedCart.cartItems, normalizedIso3, {
      state_iso2: stateIso2,
    });

    return NextResponse.json({ success: true, totals });
  } catch (error) {
    console.error('[API] Failed to fetch shipping estimate', error);
    return NextResponse.json(
      { success: false, error: 'Unable to compute shipping estimate.' },
      { status: 500 },
    );
  }
}
