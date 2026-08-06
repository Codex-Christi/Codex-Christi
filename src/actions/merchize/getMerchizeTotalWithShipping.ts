// src/actions/merchize/getMerchizeTotalWithShipping.ts
'use server';

import { cache } from 'react';
import { ShippingCountryObj } from '@/lib/datasetSearchers/shippingSupportMerchize';
import { CartVariant } from '@/stores/shop_stores/cartStore';
import { getStrictCatalogVariantsBySku } from '@/lib/datasetSearchers/merchize/catalog';
import { currencyCodesWithoutDecimalPrecision } from '@/datasets/shop_general/paypal_currency_specifics';
import { symbolFromCurrency } from '@/lib/currency/symbol';
import { getShippingPriceMerchizecatalog, realTimePriceFromMerchize } from './priceFromMerchize';

export type VariantUnitMeta = {
  variantId: string | undefined;
  parentProductID: string | undefined;
  unitPriceUSD?: number;
  quantity: number;
};

export const removeOrKeepDecimalPrecision = async (curr: string, num: number) =>
  currencyCodesWithoutDecimalPrecision.includes(curr ?? 'USD')
    ? Number(num.toFixed(0))
    : Math.round((num + Number.EPSILON) * 100) / 100;

export const getMerchizeTotalWIthShipping = cache(
  async (
    cart: CartVariant[],
    country_iso3: ShippingCountryObj['country_iso3'],
    opts?: { state_iso2?: string },
  ) => {
    const skuCountsMap = new Map<string, number>();
    const uniqueSkus: string[] = [];
    let totalUnits = 0;

    for (const item of cart) {
      const sku = item.itemDetail?.supplierSku;
      if (!sku) {
        throw new Error(`Cart variant ${item.variantId} is missing a verified supplier SKU.`);
      }
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
        throw new Error(`Cart variant ${item.variantId} has an invalid quantity.`);
      }
      if (!skuCountsMap.has(sku)) {
        uniqueSkus.push(sku);
      }
      const currentQty = skuCountsMap.get(sku) ?? 0;
      const nextQty = currentQty + item.quantity;
      skuCountsMap.set(sku, nextQty);
      totalUnits += item.quantity;
    }

    if (!totalUnits) {
      return {
        shippingPriceNum: 0,
        retailPriceTotalNum: 0,
        currency: 'USD',
        currency_symbol: '$',
        multiplier: null as number | null,
      };
    }

    const skuCountsEntries = Array.from(skuCountsMap.entries());

    const catalogVariants = await getStrictCatalogVariantsBySku(uniqueSkus);
    const catalogRows = catalogVariants.map((variant) => variant.catalogRow);

    const variantsAndParents: VariantUnitMeta[] = cart
      .map(({ itemDetail, variantId, quantity }) => ({
        variantId,
        parentProductID: itemDetail?.product,
        unitPriceUSD:
          typeof itemDetail?.retail_price === 'number' ? itemDetail.retail_price : undefined,
        quantity,
      }))
      .filter((meta) => meta.quantity > 0);

    const [shippingPriceObj, realTimePriceTotal] = await Promise.all([
      getShippingPriceMerchizecatalog(catalogRows, country_iso3, {
        ...opts,
        skuCounts: skuCountsEntries,
        totalUnitsOverride: totalUnits,
      }),
      realTimePriceFromMerchize(variantsAndParents, country_iso3),
    ]);

    const currency = shippingPriceObj.currency || realTimePriceTotal.currency || 'USD';
    const currency_symbol =
      shippingPriceObj.currency_symbol ??
      realTimePriceTotal.currency_symbol ??
      symbolFromCurrency(currency);

    return {
      ...shippingPriceObj,
      ...realTimePriceTotal,
      currency,
      currency_symbol,
      shippingPriceNum: Number(
        await removeOrKeepDecimalPrecision(currency, shippingPriceObj.shippingPriceNum),
      ),
      retailPriceTotalNum: Number(
        await removeOrKeepDecimalPrecision(currency, realTimePriceTotal.retailPriceTotalNum),
      ),
    };
  },
);
