import { format } from 'date-fns';
import type {
  CheckoutPaymentIntent,
  ItemCategory,
  ItemRequest,
  OrderRequest,
} from '@paypal/paypal-server-sdk';
import type { CanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/types';
import { getShopSiteUrl } from '@/lib/siteBaseUrls';
import type { ShopCheckoutStoreInterface } from '@/stores/shop_stores/checkoutStore';

export type BuildPayPalOrderCreatePayloadInput = Readonly<{
  orderToken: string;
  canonicalOrderSnapshot: CanonicalOrderSnapshot;
  customer: Readonly<{ name: string; email: string }>;
  /** PayPal requires the ISO-2 country code for its provided shipping address. */
  country: string;
  delivery_address: ShopCheckoutStoreInterface['delivery_address'];
}>;

export type PayPalOrderCreatePayload = Readonly<{
  body: OrderRequest;
  prefer: 'return=representation';
}>;

const shippingPreferenceForPaymentContext = {
  experienceContext: {
    shippingPreference: 'SET_PROVIDED_ADDRESS' as const,
    brandName: 'Codex Christi',
  },
};

function buildPayPalItem(
  line: CanonicalOrderSnapshot['lines'][number],
  currencyCode: string,
): ItemRequest {
  return {
    name: line.title,
    unitAmount: {
      currencyCode,
      value: line.unitAmount.value,
    },
    quantity: String(line.quantity),
    description: line.title,
    sku: line.sellerSku ?? line.sku,
    url: getShopSiteUrl(`/product/${line.productId}`),
    imageUrl: line.imageUrl,
    category: 'PHYSICAL_GOODS' as ItemCategory,
  };
}

/**
 * Maps an already-verified canonical order snapshot to PayPal's create-order
 * request. It performs no price, currency, cart, shipping, or tax resolution.
 */
export function buildPayPalOrderCreatePayload({
  orderToken,
  canonicalOrderSnapshot,
  customer,
  country,
  delivery_address,
}: BuildPayPalOrderCreatePayloadInput): PayPalOrderCreatePayload {
  const currencyCode = canonicalOrderSnapshot.currency;
  const items = canonicalOrderSnapshot.lines.map((line) => buildPayPalItem(line, currencyCode));

  return {
    body: {
      intent: 'AUTHORIZE' as CheckoutPaymentIntent,
      purchaseUnits: [
        {
          description: `Codex Christi Shop Order for ${customer.name} on ${format(
            new Date(canonicalOrderSnapshot.createdAt),
            "EEEE d 'of' MMMM yyyy hh:mm a",
          )}`,
          amount: {
            currencyCode,
            value: canonicalOrderSnapshot.total.value,
            breakdown: {
              itemTotal: {
                currencyCode,
                value: canonicalOrderSnapshot.subtotal.value,
              },
              shipping: {
                currencyCode,
                value: canonicalOrderSnapshot.shipping.value,
              },
            },
          },
          shipping: {
            name: {
              fullName: customer.name,
            },
            address: {
              addressLine1: delivery_address.shipping_address_line_1,
              addressLine2: delivery_address.shipping_address_line_2,
              adminArea1: delivery_address.shipping_state,
              adminArea2: delivery_address.shipping_city,
              postalCode: delivery_address.zip_code,
              countryCode: country,
            },
            emailAddress: customer.email,
          },
          // PayPal echoes this as custom_id in some webhooks. Locally it is the ledger orderToken,
          // not Django's payment-save custom_id.
          customId: orderToken,
          items,
        },
      ],
      payer: {
        name: { givenName: customer.name },
        emailAddress: customer.email,
      },
      paymentSource: {
        paypal: shippingPreferenceForPaymentContext,
        card: {
          experienceContext: shippingPreferenceForPaymentContext.experienceContext,
          attributes: {
            verification: {
              method: 'SCA_WHEN_REQUIRED',
            },
          },
        },
        venmo: shippingPreferenceForPaymentContext,
      },
    } as OrderRequest,
    prefer: 'return=representation',
  };
}
