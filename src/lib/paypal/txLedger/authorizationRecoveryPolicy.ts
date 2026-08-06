import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { hasProcessingAuthorizePayload } from '@/lib/paypal/txLedger/paymentReconciliationEvidence';

/**
 * A verified authorization webhook can win the race with the authorize route. In that state the
 * status is already `authorized`, but the order-shaped payload may not yet be durable. The route
 * must fetch PayPal order truth instead of rejecting the state or attempting a second authorize.
 */
export function shouldResyncExistingAuthorization(args: {
  status: string;
  authorizePayload: unknown;
}) {
  return (
    args.status === PAYPAL_LEDGER_STATUS.ERROR ||
    (args.status === PAYPAL_LEDGER_STATUS.AUTHORIZED &&
      !hasProcessingAuthorizePayload(args.authorizePayload))
  );
}
