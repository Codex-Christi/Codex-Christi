import type { CanonicalOrderSnapshotLedgerEnvelope } from '@/lib/paypal/orderSnapshot/canonicalize';

export type JsonRecord = Record<string, unknown>;

export type MerchizeOrderLookupResponse = {
  success?: boolean;
  message?: string;
  data?: JsonRecord | null;
};

export type MerchizeInDepthOrderDetailResponse = {
  success?: boolean;
  message?: string;
  data?: JsonRecord | null;
};

export type MerchizeExternalOrderFulfillmentCost = {
  discount_amount?: number;
  shipping_cost?: number;
  fulfillment_cost?: number;
  branding_cost?: number;
  amount?: number;
  currency?: string;
  status?: string;
  paid_at?: string;
  created?: string;
};

export type MerchizeExternalOrderInvoiceRow = {
  code?: string;
  external_number?: string;
  identifier?: string;
  transaction_fee?: number;
  // Merchize currently returns 0 before an invoice exists, despite documenting an object.
  fulfillment_cost?: MerchizeExternalOrderFulfillmentCost | number | null;
  fulfillment_refund?: unknown[];
  fulfillment_charge?: unknown[];
};

export type MerchizeExternalOrderInvoiceResponse = {
  success?: boolean;
  message?: string;
  data?: MerchizeExternalOrderInvoiceRow[] | null;
};

export type MerchizeFulfillmentRegistrationInput = CanonicalOrderSnapshotLedgerEnvelope & {
  orderToken: string;
  paypalOrderId: string | null;
  djangoOrderIntentUuid: string | null;
  djangoOrderIntentOrderId: string | null;
  djangoPaymentSaveCustomId: string;
  fulfillmentIdentifier?: string | null;
  merchizeExternalOrderNumber: string;
  merchizeOrderId: string | null;
  merchizeOrderCode: string | null;
  merchizeStatus: string | null;
  djangoProcessResponsePayload: unknown;
  customerEmail?: string | null;
  shippingSnapshot?: unknown;
  cartSnapshot?: unknown;
};

export type MerchizeFulfillmentSyncResult =
  | {
      ok: true;
      orderToken: string;
      merchizeExternalOrderNumber: string;
      merchizeOrderId: string;
      itemCount: number;
    }
  | {
      ok: false;
      orderToken: string;
      errorCode: string;
      errorMessage: string;
      pending?: boolean;
      retryable?: boolean;
    };
