import { randomUUID } from 'crypto';
import type { Order } from '@paypal/paypal-server-sdk';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { createPayPalOrder } from '@/lib/paypal/createPayPalOrder';
import { paypalRouteError, paypalRouteSuccess } from '@/lib/paypal/txLedger/routeResponses';
import { getServerSessionState } from '@/lib/session/server-session';
import { refreshPaidOrderRecoveryProjectionSafely } from '@/lib/paypal/txLedger/paidOrderRecoveryProjection';
import { getCheckoutSurfaceProvenance } from '@/lib/paypal/txLedger/checkoutSurfaceProvenance';
import {
  CanonicalOrderResolutionError,
} from '@/lib/paypal/orderSnapshot/resolver';
import type { CanonicalOrderResolutionInput } from '@/lib/paypal/orderSnapshot/types';
import { resolveCanonicalOrderSnapshotFromMerchize } from '@/lib/paypal/orderSnapshot/merchizeResolver';
import { getCountrySupport } from '@/lib/datasetSearchers/shippingSupportMerchize';
import { normalizeCountryToIso3 } from '@/lib/utils/shop/checkout/normalizeCountryToIso3';
import type { ShopCheckoutStoreInterface } from '@/stores/shop_stores/checkoutStore';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasRequiredDeliveryAddress(
  value: unknown,
): value is ShopCheckoutStoreInterface['delivery_address'] {
  const address = asRecord(value);
  return Boolean(
    address &&
      nonEmptyString(address.shipping_address_line_1) &&
      nonEmptyString(address.shipping_city) &&
      nonEmptyString(address.shipping_state) &&
      nonEmptyString(address.shipping_country) &&
      nonEmptyString(address.zip_code),
  );
}

function toLedgerJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

export async function POST(req: Request) {
  const requestId = randomUUID();
  let orderToken: string | undefined;
  const validationError = (code: string, message: string) =>
    paypalRouteError({
      status: 400,
      code,
      stage: 'validate_request',
      message,
      requestId,
    });

  const logRouteError = (stage: string, code: string, err: unknown) => {
    console.error(`[paypal.intent.${stage}]`, {
      requestId,
      orderToken,
      code,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  };

  const fail = async ({
    code,
    stage,
    message,
    err,
    status = 500,
    persistToLedger = true,
  }: {
    code: string;
    stage: string;
    message: string;
    err: unknown;
    status?: number;
    persistToLedger?: boolean;
  }) => {
    logRouteError(stage, code, err);

    if (persistToLedger && orderToken) {
      try {
        await paypalTxLedger.paypalIntent.update({
          where: { orderToken },
          data: {
            status: PAYPAL_LEDGER_STATUS.ERROR,
            lastErrorCode: code,
            lastErrorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        await refreshPaidOrderRecoveryProjectionSafely(orderToken);
      } catch (ledgerError) {
        console.error('[paypal.intent.persist_error_failed]', {
          requestId,
          orderToken,
          code,
          error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        });
      }
    }

    return paypalRouteError({
      status,
      code,
      stage,
      message,
      requestId,
      orderToken,
    });
  };

  try {
    const body = asRecord(await req.json());
    if (!body) {
      return validationError('INVALID_REQUEST', 'A checkout request object is required.');
    }
    const checkoutSurface = getCheckoutSurfaceProvenance(req);
    const {
      selections,
      customer,
      delivery_address,
      djangoOrderIntentUuid,
      djangoOrderIntentOrderId,
      djangoOrderIntentPayload,
      djangoOrderIntentVerifyPayload,
    } = body;
    const customerRecord = asRecord(customer);
    const sessionState = await getServerSessionState();
    const authenticatedUserId = sessionState.isAuthenticated ? sessionState.userID : null;

    if (!Array.isArray(selections) || selections.length === 0) {
      return validationError('INVALID_CART', 'Cart required');
    }
    if (!nonEmptyString(customerRecord?.name) || !nonEmptyString(customerRecord?.email)) {
      return validationError('INVALID_CUSTOMER', 'Customer required');
    }
    if (!hasRequiredDeliveryAddress(delivery_address)) {
      return validationError('INVALID_DELIVERY_ADDRESS', 'Delivery address required');
    }

    const countryIso3 = normalizeCountryToIso3(delivery_address.shipping_country);
    if (!countryIso3) {
      return validationError(
        'INVALID_DESTINATION',
        'The selected shipping country could not be resolved.',
      );
    }

    // Resolve the ISO-2 address code from the same server country catalog used by checkout. This
    // validates consistency without introducing a new destination-eligibility policy (P0.3).
    const countrySupport = await getCountrySupport(countryIso3, 'merchize');
    if (!countrySupport.country?.country_iso2) {
      return validationError(
        'INVALID_DESTINATION',
        'The selected shipping country could not be resolved.',
      );
    }

    let canonicalOrderSnapshot;
    try {
      canonicalOrderSnapshot = await resolveCanonicalOrderSnapshotFromMerchize({
        selections: selections as CanonicalOrderResolutionInput['selections'],
        destination: {
          countryIso3,
          region: delivery_address.shipping_state,
        },
      });
    } catch (resolutionError) {
      if (resolutionError instanceof CanonicalOrderResolutionError) {
        return fail({
          code: resolutionError.code,
          stage: 'resolve_canonical_order_snapshot',
          message: resolutionError.message,
          err: resolutionError,
          status: resolutionError.status,
          persistToLedger: false,
        });
      }

      return fail({
        code: 'ORDER_SNAPSHOT_RESOLUTION_FAILED',
        stage: 'resolve_canonical_order_snapshot',
        message: 'Checkout pricing or shipping could not be verified. Please try again.',
        err: resolutionError,
        status: 503,
        persistToLedger: false,
      });
    }

    orderToken = randomUUID();

    await paypalTxLedger.paypalIntent.create({
      data: {
        orderToken,
        status: PAYPAL_LEDGER_STATUS.INTENT_CREATING,
        customerName: customerRecord.name.trim(),
        customerEmail: customerRecord.email.trim(),
        userId: authenticatedUserId,
        djangoOrderIntentUuid: nonEmptyString(djangoOrderIntentUuid)
          ? djangoOrderIntentUuid.trim()
          : null,
        djangoOrderIntentOrderId: nonEmptyString(djangoOrderIntentOrderId)
          ? djangoOrderIntentOrderId.trim()
          : null,
        djangoOrderIntentPayload:
          djangoOrderIntentPayload == null ? undefined : toLedgerJson(djangoOrderIntentPayload),
        djangoOrderIntentVerifyPayload:
          djangoOrderIntentVerifyPayload == null
            ? undefined
            : toLedgerJson(djangoOrderIntentVerifyPayload),
        countryIso2: countrySupport.country.country_iso2,
        countryIso3,
        initialCurrency: canonicalOrderSnapshot.currency,
        // Required legacy column; new consumers use the sealed canonical snapshot instead.
        cartSnapshot: toLedgerJson(selections),
        shippingSnapshot: delivery_address,
        canonicalOrderSnapshot: toLedgerJson(canonicalOrderSnapshot),
        canonicalOrderSnapshotVersion: canonicalOrderSnapshot.version,
        canonicalOrderSnapshotHash: canonicalOrderSnapshot.hash,
        ...checkoutSurface,
      },
    });
    await refreshPaidOrderRecoveryProjectionSafely(orderToken);

    let paypalOrder: Order;
    try {
      paypalOrder = await createPayPalOrder({
        orderToken,
        canonicalOrderSnapshot,
        customer: {
          name: customerRecord.name.trim(),
          email: customerRecord.email.trim(),
        },
        country: countrySupport.country.country_iso2,
        delivery_address,
      });
    } catch (createErr) {
      return fail({
        code: 'CREATE_ORDER_FAILED',
        stage: 'create_paypal_order',
        message: 'Failed to create PayPal order',
        err: createErr,
      });
    }

    if (!paypalOrder?.id) {
      return fail({
        code: 'MISSING_PAYPAL_ORDER_ID',
        stage: 'persist_paypal_order_id',
        message: 'Missing PayPal order ID',
        err: new Error('createPayPalOrder returned no id'),
      });
    }

    try {
      await paypalTxLedger.paypalIntent.update({
        where: { orderToken },
        data: {
          paypalOrderId: paypalOrder.id,
          status: PAYPAL_LEDGER_STATUS.INTENT_CREATED,
        },
      });
      await refreshPaidOrderRecoveryProjectionSafely(orderToken);
    } catch (persistErr) {
      return fail({
        code: 'LEDGER_UPDATE_FAILED',
        stage: 'persist_paypal_order_id',
        message: 'Failed to persist PayPal order details',
        err: persistErr,
      });
    }

    return paypalRouteSuccess({
      requestId,
      data: {
        orderToken,
        paypalOrderId: paypalOrder.id,
      },
    });
  } catch (err) {
    return fail({
      code: 'INTENT_FAILED',
      stage: 'intent_route',
      message: 'Failed to create PayPal intent',
      err,
    });
  }
}
