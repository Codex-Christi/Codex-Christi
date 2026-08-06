'use server';

import fs from 'node:fs/promises';
import path from 'path';
import { uploadPaymentReceiptToR2 } from '../../checkout/transactions/uploadPaymentReceipt';
import { createPaypalShopInvoicePDF } from '../createShopInvoicePDF';
import type { CompletedTxInterface } from '@/types/shop/paypalCompletedTx';
import { decryptForPostProcessingServerAction } from '@/lib/utils/shop/checkout/serverPostProcessingCrypto';
import type { CanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/types';

export interface PaymentReceiptProps {
  authData: CompletedTxInterface['authData'];
  cart?: CompletedTxInterface['cart'];
  canonicalOrderSnapshot?: CanonicalOrderSnapshot | null;
  customer: CompletedTxInterface['customer'];
  ORD_string: CompletedTxInterface['ORD_string'];
  shippingAddressOverride?: {
    shipping_address_line_1: string;
    shipping_address_line_2?: string;
    shipping_city: string;
    shipping_state: string;
    zip_code: string;
    shipping_country: string;
  } | null;
}

export const savePaymentReceiptToCloud = async (encodedProps: string) => {
  try {
    // Decrypt and parse data
    const {
      authData,
      cart,
      canonicalOrderSnapshot,
      customer,
      ORD_string,
      shippingAddressOverride,
    } = JSON.parse(
      decryptForPostProcessingServerAction(encodedProps),
    ) as PaymentReceiptProps;
    const { email: customerEmail, name: customerName } = customer || {};

    const pdfBuffer = await createPaypalShopInvoicePDF(
      authData,
      cart,
      shippingAddressOverride,
      canonicalOrderSnapshot,
    );

    // Upload to r2
    const { accessLink } = await uploadPaymentReceiptToR2({
      fileBody: pdfBuffer,
      filename: `invoice-${authData.id}-${customerName}-${customerEmail}.pdf`,
    });

    // Post order data to backend
    if (!ORD_string || ORD_string === '') {
      throw new Error('Missing order identifier for backend processing.');
    }

    const clientSideResp = {
      success: true,
      pdfReceiptLink: accessLink,
      receiptFileName: `invoice-${authData.id}-${customerName}-${customerEmail}`,
    };
    return clientSideResp;

    // Catch errors
  } catch (error: unknown) {
    // Save error details
    const errorDir = path.join(process.cwd(), 'transaction-errors');
    await fs.mkdir(errorDir, { recursive: true });

    let errorMessage = 'Unknown error';
    let errorStack = undefined;
    if (error instanceof Error) {
      errorMessage = error.message;
      errorStack = error.stack; // Preserving stack trace
    }
    console.log('TX Upload Err: ', error);

    const errorPath = path.join(errorDir, `error-${Date.now()}.json`);
    await fs.writeFile(
      errorPath,
      JSON.stringify(
        {
          error: errorMessage,
          stack: errorStack, // Preserved stack in error file
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // Try to save customer details offline for manual re-upload
    // To-Do...

    // //FOR DEV USE
    // throw new Error(errorMessage);

    //Production use, till we figure out a way to capture unprocessed orders
    return {
      success: false,
      message: errorMessage,
      errorId: path.basename(errorPath),
    };
  }
};
