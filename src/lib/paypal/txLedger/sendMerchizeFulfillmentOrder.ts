import 'server-only';

import {
  sendMerchizeOrderDetailsToBackend,
  type OrderProcessingAPIResponse,
} from '@/actions/shop/checkout/createMerchizeOrder/sendMerchizeOrderDetailsToBackend';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import type { PaymentSavingActionProps } from '@/actions/shop/paypal/processAndUploadCompletedTx/savePaymentDataToBackend';
import { encryptForPostProcessingServerAction } from '@/lib/utils/shop/checkout/serverPostProcessingCrypto';
import { normalizeCountryToIso2 } from '@/lib/utils/shop/checkout/normalizeCountryToIso3';
import type { CanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/types';
import { parseCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import { getCanonicalFulfillmentItems } from '@/lib/paypal/orderSnapshot/consumerData';

export type MerchizeFulfillmentOrderArgs = {
  cartSnapshot: CartVariant[];
  canonicalOrderSnapshot?: CanonicalOrderSnapshot | null;
  djangoPaymentSaveCustomId: string;
  identifier: string;
  currency: string;
  customerName: string;
  customerPhone?: string | null;
  countryIso2?: string | null;
  fulfillmentAddress: PaymentSavingActionProps['delivery_address'];
};

type OrderProcessingItem = {
  product_id: string;
  sku: string;
  merchize_sku: string;
  quantity: number;
  price: number;
  currency: string;
  image: string;
};

type MerchizeFulfillmentProcessPayload = {
  identifier: string;
  items: OrderProcessingItem[];
  first_name: string;
  last_name: string;
  address: string;
  address_2: string;
  city: string;
  state: string;
  zip_code: string;
  country: string;
  phone: string;
};

type MerchizeFulfillmentProcessProps = {
  djangoPaymentSaveCustomId: string;
  payload: MerchizeFulfillmentProcessPayload;
};

export type FulfillmentValidationIssue = {
  field: string;
  message: string;
};

export class FulfillmentPayloadValidationError extends Error {
  issues: FulfillmentValidationIssue[];
  requestPayload: MerchizeFulfillmentProcessPayload;

  constructor(
    issues: FulfillmentValidationIssue[],
    requestPayload: MerchizeFulfillmentProcessPayload,
  ) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    this.name = 'FulfillmentPayloadValidationError';
    this.issues = issues;
    this.requestPayload = requestPayload;
  }
}

export class FulfillmentProviderRejectedError extends Error {
  requestPayload: MerchizeFulfillmentProcessPayload;
  responsePayload: OrderProcessingAPIResponse;

  constructor(
    message: string,
    args: {
      requestPayload: MerchizeFulfillmentProcessPayload;
      responsePayload: OrderProcessingAPIResponse;
    },
  ) {
    super(message);
    this.name = 'FulfillmentProviderRejectedError';
    this.requestPayload = args.requestPayload;
    this.responsePayload = args.responsePayload;
  }
}

function isFulfillmentBusinessFailure(error: unknown): error is {
  businessFailure: true;
  message: string;
  responsePayload: OrderProcessingAPIResponse;
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'businessFailure' in error &&
    (error as { businessFailure?: unknown }).businessFailure === true &&
    'responsePayload' in error
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getStringPath(root: unknown, path: string[]) {
  const value = path.reduce<unknown>((current, key) => asRecord(current)?.[key], root);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getMerchizeOrderIdentifiersFromDjangoProcessingResponse(
  response: OrderProcessingAPIResponse,
) {
  const djangoData = response.data;
  const responseData = djangoData?.response_data;
  const wrappedMerchizeOrderId = getStringPath(responseData, ['data', 'data', 'order_id']);

  return {
    merchizeExternalOrderNumber:
      wrappedMerchizeOrderId ?? djangoData?.order_intent_order_id ?? null,
    // The actionable Merchize platform ID comes from the external-number lookup
    // response data._id in Merchize Fulfillment Ops, not from this Django process
    // response wrapper.
    merchizeProviderOrderId: null,
    merchizeProviderOrderCode: djangoData?.provider_order_code ?? wrappedMerchizeOrderId,
    merchizeProviderStatus: getStringPath(responseData, ['data', 'status']),
  };
}

function mapCartToProcessingItems(cart: CartVariant[], currency: string): OrderProcessingItem[] {
  return cart.map((item) => ({
    product_id: item.itemDetail.product ?? item.variantId,
    sku: item.itemDetail.sku_seller ?? '',
    merchize_sku: item.itemDetail.sku ?? item.variantId,
    quantity: item.quantity,
    price: item.itemDetail.retail_price,
    currency,
    image: item.itemDetail.image ?? item.itemDetail.image_uris?.[0] ?? '',
  }));
}

function getProcessingItemIssues(items: OrderProcessingItem[]) {
  const issues: FulfillmentValidationIssue[] = [];

  for (const item of items) {
    if (!item.product_id) {
      issues.push({
        field: 'items.product_id',
        message: 'Missing product_id for fulfillment item',
      });
    }
    if (!item.merchize_sku) {
      issues.push({
        field: 'items.merchize_sku',
        message: 'Missing merchize_sku for fulfillment item',
      });
    }
    if (!item.image) {
      issues.push({ field: 'items.image', message: 'Missing image for fulfillment item' });
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      issues.push({ field: 'items.quantity', message: 'Invalid quantity for fulfillment item' });
    }
    if (typeof item.price !== 'number' || item.price < 0) {
      issues.push({ field: 'items.price', message: 'Invalid price for fulfillment item' });
    }
    if (!item.currency) {
      issues.push({ field: 'items.currency', message: 'Missing currency for fulfillment item' });
    }
  }

  return issues;
}

function getFulfillmentPayloadIssues(payload: MerchizeFulfillmentProcessPayload) {
  const issues: FulfillmentValidationIssue[] = [];

  if (!payload.identifier) {
    issues.push({ field: 'identifier', message: 'Missing identifier for fulfillment payload' });
  }

  const requiredFields: Array<keyof MerchizeFulfillmentProcessPayload> = [
    'items',
    'first_name',
    'address',
    'city',
    'state',
    'zip_code',
    'country',
  ];

  for (const field of requiredFields) {
    if (!payload[field]) {
      issues.push({ field, message: `Missing ${field} for fulfillment payload` });
    }
  }

  issues.push(...getProcessingItemIssues(payload.items));

  return issues;
}

function splitCustomerName(fullName: string) {
  const [firstName = '', ...rest] = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    first_name: firstName,
    last_name: rest.join(' '),
  };
}

function buildFulfillmentPayload(
  args: MerchizeFulfillmentOrderArgs,
  items: OrderProcessingItem[],
): MerchizeFulfillmentProcessPayload {
  const { first_name, last_name } = splitCustomerName(args.customerName);
  const address = args.fulfillmentAddress;
  const country = normalizeCountryToIso2(args.countryIso2 || address?.shipping_country);

  return {
    identifier: args.identifier,
    items,
    first_name,
    last_name,
    address: address?.shipping_address_line_1 ?? '',
    address_2: address?.shipping_address_line_2 ?? '',
    city: address?.shipping_city ?? '',
    state: address?.shipping_state ?? '',
    zip_code: address?.zip_code ?? '',
    country: country ?? '',
    phone: args.customerPhone ?? '',
  };
}

export async function sendMerchizeFulfillmentOrder(args: MerchizeFulfillmentOrderArgs) {
  // Canonical orders never consult the browser cart. Legacy rows retain their original mapping.
  const items = args.canonicalOrderSnapshot
    ? getCanonicalFulfillmentItems(parseCanonicalOrderSnapshot(args.canonicalOrderSnapshot))
    : mapCartToProcessingItems(args.cartSnapshot, args.currency);
  const requestPayload = buildFulfillmentPayload(args, items);
  const validationIssues = getFulfillmentPayloadIssues(requestPayload);

  if (validationIssues.length > 0) {
    throw new FulfillmentPayloadValidationError(validationIssues, requestPayload);
  }

  const payload = {
    djangoPaymentSaveCustomId: args.djangoPaymentSaveCustomId,
    payload: requestPayload,
  } satisfies MerchizeFulfillmentProcessProps;

  const response = await sendMerchizeOrderDetailsToBackend(
    encryptForPostProcessingServerAction(JSON.stringify(payload), 'fulfillment'),
  );

  if (!response.ok) {
    if (isFulfillmentBusinessFailure(response.error)) {
      throw new FulfillmentProviderRejectedError(response.error.message, {
        requestPayload,
        responsePayload: response.error.responsePayload,
      });
    }

    throw new Error(response.error?.message ?? 'Fulfillment push failed');
  }

  return {
    ...response,
    requestPayload,
    merchizeOrderIdentifiers: getMerchizeOrderIdentifiersFromDjangoProcessingResponse(response),
  };
}
