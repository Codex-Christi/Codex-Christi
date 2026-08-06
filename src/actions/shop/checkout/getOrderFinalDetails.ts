'use server';

import { getMerchizeTotalWIthShipping } from '@/actions/merchize/getMerchizeTotalWithShipping';
import {
  dropShippingSupplier,
  getCountrySupport,
  ShippingCountryObj,
} from '@/lib/datasetSearchers/shippingSupportMerchize';
import { CartVariant } from '@/stores/shop_stores/cartStore';
import { cache } from 'react';
import { hydrateCartDisplayFromMerchizeOfflineCatalog } from '@/actions/shop/cart/hydrateCartDisplayFromMerchizeOfflineCatalog';
import { hasCheckoutBlockingCartItems } from '@/components/UI/Shop/Cart/cartAvailability';

export const getOrderFinalDetails = cache(
  async (
    cart: CartVariant[],
    country_iso3: ShippingCountryObj['country_iso3'],
    supplier: dropShippingSupplier,
  ) => {
    const verifiedCart = await hydrateCartDisplayFromMerchizeOfflineCatalog(cart);
    if (hasCheckoutBlockingCartItems(cart, verifiedCart.availabilityByVariantId)) {
      throw new Error('One or more cart variants are unavailable or could not be verified.');
    }
    const [countrySupport, finalPricesWithShippingFee] = await Promise.all([
      getCountrySupport(country_iso3, supplier),
      getMerchizeTotalWIthShipping(verifiedCart.cartItems, country_iso3),
    ]);

    return { countrySupport, finalPricesWithShippingFee };
  },
);
