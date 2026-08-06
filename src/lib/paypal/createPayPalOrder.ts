import 'server-only';

import { OrdersController, type Order } from '@paypal/paypal-server-sdk';
import { parseCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import { getPayPalClient } from '@/lib/paymentClients/paypalClient';
import {
  buildPayPalOrderCreatePayload,
  type BuildPayPalOrderCreatePayloadInput,
} from './createPayPalOrderPayload';

export {
  buildPayPalOrderCreatePayload,
  type BuildPayPalOrderCreatePayloadInput,
  type PayPalOrderCreatePayload,
} from './createPayPalOrderPayload';

export interface BillingAddressInterface {
  addressLine1: string;
  addressLine2: string;
  adminArea1: string;
  adminArea2: string;
  countryCode: string;
  postalCode: string;
}

export type CreateOrderActionInterface = BuildPayPalOrderCreatePayloadInput;

export async function createPayPalOrder(body: CreateOrderActionInterface): Promise<Order> {
  const { orderToken, canonicalOrderSnapshot, customer, delivery_address } = body;

  if (!orderToken) {
    throw new Error('Missing order token');
  }
  if (!canonicalOrderSnapshot) {
    throw new Error('Missing canonical order snapshot');
  }
  if (!customer) {
    throw new Error('Missing customer');
  }
  if (!delivery_address) {
    throw new Error('Missing delivery address!');
  }

  // Fail closed if a caller passes a stale, malformed, or hash-mismatched snapshot.
  const verifiedSnapshot = parseCanonicalOrderSnapshot(canonicalOrderSnapshot);
  const payload = buildPayPalOrderCreatePayload({
    ...body,
    canonicalOrderSnapshot: verifiedSnapshot,
  });

  const orders = new OrdersController(getPayPalClient());
  const { result } = await orders.createOrder(payload);

  return result;
}
