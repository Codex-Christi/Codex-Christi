'use server';

import { FetcherError, FetcherOptions, universalFetcher } from '@/lib/utils/SWRfetcherAdvanced';
import { generateSignatureHeaders } from '@/lib/hooks/shopHooks/checkout/helpers/generateSignatureHeaders';
import { returnReducedBackendError } from '@/lib/hooks/shopHooks/checkout/helpers/returnReducedBackendError';
import { decryptForPostProcessingServerAction } from '@/lib/utils/shop/checkout/serverPostProcessingCrypto';
import { getServerDjangoApiBaseUrl } from '@/lib/django/getServerDjangoApiBaseUrl';

const baseURL = getServerDjangoApiBaseUrl();

interface OrderProcessingItem {
  product_id: string;
  sku: string;
  merchize_sku: string;
  quantity: number;
  price: number;
  currency: string;
  image: string;
}

interface MerchizeFulfillmentProcessPayload {
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
}

interface MerchizeFulfillmentProcessProps {
  djangoPaymentSaveCustomId: string;
  payload: MerchizeFulfillmentProcessPayload;
}

export interface OrderProcessingAPIResponse {
  status: number;
  success: boolean;
  message: string;
  data: {
    id: string;
    order_payment_custom_id: string;
    order_intent_id: string;
    order_intent_order_id: string;
    provider_order_id: string | null;
    provider_order_code: string | null;
    processing_status:
      | 'pending'
      | 'processing'
      | 'shipped'
      | 'delivered'
      | 'cancelled'
      | 'completed'
      | 'failed';
    request_data: Record<string, unknown>;
    response_data: Record<string, unknown> | null;
    error_message: string | null;
    retry_count: number;
    date_created: string;
    date_updated: string;
  };
}

const ACCEPTED_INFORMATIONAL_MESSAGES = new Set(['order created but details not available']);
const IDEMPOTENT_PROVIDER_MESSAGES = new Set(['order is duplicated']);

function normalizeProviderMessage(message: string | null | undefined) {
  return message?.trim().toLowerCase() ?? '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getNestedProviderErrorMessage(response: OrderProcessingAPIResponse) {
  const responseData = asRecord(response.data?.response_data);
  const providerData = asRecord(responseData?.data);
  const nestedError = providerData?.error;

  return typeof nestedError === 'string' ? nestedError : null;
}

function isAcceptedInformationalMessage(message: string | null | undefined) {
  return ACCEPTED_INFORMATIONAL_MESSAGES.has(normalizeProviderMessage(message));
}

function isIdempotentProviderMessage(message: string | null | undefined) {
  return IDEMPOTENT_PROVIDER_MESSAGES.has(normalizeProviderMessage(message));
}

function isDjangoFulfillmentBusinessSuccess(response: OrderProcessingAPIResponse) {
  const nestedProviderError = getNestedProviderErrorMessage(response);

  if (isIdempotentProviderMessage(nestedProviderError)) {
    return response.success === true;
  }

  if (response.success !== true) return false;
  if (response.data?.processing_status === 'failed') return false;

  return (
    !response.data?.error_message || isAcceptedInformationalMessage(response.data.error_message)
  );
}

function getDjangoFulfillmentFailureMessage(response: OrderProcessingAPIResponse) {
  return (
    getNestedProviderErrorMessage(response) ||
    response.data?.error_message ||
    response.message ||
    'Django fulfillment processing returned a business failure'
  );
}

export const sendMerchizeOrderDetailsToBackend = async (encProps: string) => {
  const { djangoPaymentSaveCustomId, payload } = JSON.parse(
    decryptForPostProcessingServerAction(encProps, 'fulfillment'),
  ) as MerchizeFulfillmentProcessProps;

  if (!djangoPaymentSaveCustomId) {
    throw new Error('Missing Django payment save custom_id before fulfillment processing');
  }

  try {
    // Django names this route segment `{custom_id}`. Locally it is always the
    // payment-save custom ID returned by /orders/order-payment.
    const response = await universalFetcher<OrderProcessingAPIResponse, typeof payload>(
      `${baseURL}/orders/process/${djangoPaymentSaveCustomId}`,
      {
        arg: payload,
        fetcherOptions: {
          method: 'POST',
          headers: { ...(await generateSignatureHeaders()) },
        } satisfies FetcherOptions,
      },
    );

    if (!isDjangoFulfillmentBusinessSuccess(response)) {
      return {
        ok: false as const,
        error: {
          message: getDjangoFulfillmentFailureMessage(response),
          status: response.status,
          businessFailure: true as const,
          responsePayload: response,
        },
      };
    }

    return { ok: true as const, ...response };
  } catch (err: FetcherError | unknown) {
    if (err instanceof FetcherError) {
      return {
        ok: false as const,
        error: returnReducedBackendError(err),
      };
    }

    return { ok: false as const, error: { message: 'Unknown error' } };
  }
};
