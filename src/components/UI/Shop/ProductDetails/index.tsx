'use client';
import { ProductResult, ProductVariantsInterface } from '@/lib/merchizeStorefront/productTypes';
import { createContext, useContext, FC, ReactNode, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

const ProductTitleAndSizesEtc = dynamic(() => import('./ProductTitleAndSizesEtc'));

export interface ProductDetailsProps {
  // Define any props if needed
  productId: string;
  fetchedProductData: ProductResult;
  initialImageUrls: string[];
  descriptionSection?: ReactNode;
  children?: ReactNode;
}

export interface OptionalProductVariantProps {
  variants: Partial<ProductDetailsProps['fetchedProductData']['productVariants']>;
  productMetaData?: { title: string; slug: string };
  isLoadingVariants?: boolean;
}

type VariantLoadState = 'loading' | 'ready' | 'error';
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// Use ProductResult directly as the context type
export type ProductDetailsContextValue = ProductResult & {
  productId: string;
  initialImageUrls: string[];
  variantLoadState: VariantLoadState;
  variantLoadError: string | null;
};

export const ProductDetailsContext = createContext<ProductDetailsContextValue | undefined>(
  undefined,
);

export const useProductDetailsContext = () => {
  const context = useContext(ProductDetailsContext);
  if (!context) {
    throw new Error('useProductDetailsContext must be used within ProductDetailsProvider');
  }
  return context;
};

export const ProductDetailsProvider: FC<ProductDetailsProps> = ({
  productId,
  fetchedProductData,
  initialImageUrls,
  children,
}) => {
  const [productVariants, setProductVariants] = useState<ProductVariantsInterface['data']>(
    fetchedProductData.productVariants,
  );
  const [variantLoadState, setVariantLoadState] = useState<VariantLoadState>(
    fetchedProductData.productVariants.length > 0 ? 'ready' : 'loading',
  );
  const [variantLoadError, setVariantLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (productVariants.length > 0) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof window.setTimeout> | null = null;
    let idleId: number | null = null;
    const controller = new AbortController();
    const idleWindow = window as IdleWindow;

    const loadVariants = async () => {
      setVariantLoadState('loading');
      setVariantLoadError(null);

      try {
        const res = await fetch(
          `/next-api/shop/products/${encodeURIComponent(productId)}/variants`,
          {
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        const json = (await res.json()) as {
          data?: ProductVariantsInterface['data'];
          error?: string;
          verificationIncomplete?: boolean;
        };

        if (!res.ok || !Array.isArray(json.data)) {
          throw new Error(json.error || 'Unable to load product options.');
        }

        if (json.verificationIncomplete && json.data.length === 0) {
          throw new Error('Product availability could not be verified. Please try again.');
        }

        if (cancelled) return;

        setProductVariants(json.data);
        setVariantLoadState('ready');
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;

        setVariantLoadState('error');
        setVariantLoadError(err instanceof Error ? err.message : 'Unable to load product options.');
      }
    };

    const scheduleLoad = () => {
      void loadVariants();
    };

    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(scheduleLoad, { timeout: 900 });
    } else {
      timeoutId = globalThis.setTimeout(scheduleLoad, 120);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    };
  }, [productId, productVariants.length]);

  const contextValue = useMemo<ProductDetailsContextValue>(
    () => ({
      productId,
      initialImageUrls,
      productMetaData: fetchedProductData.productMetaData,
      productVariants,
      variantLoadState,
      variantLoadError,
    }),
    [
      fetchedProductData.productMetaData,
      initialImageUrls,
      productId,
      productVariants,
      variantLoadError,
      variantLoadState,
    ],
  );

  return (
    <ProductDetailsContext.Provider value={contextValue}>
      {children ?? <ProductTitleAndSizesEtc />}
    </ProductDetailsContext.Provider>
  );
};

export const ProductPurchasePanelContent = () => <ProductTitleAndSizesEtc />;

const ProductDetails: FC<ProductDetailsProps> = (props) => {
  return (
    <ProductDetailsProvider {...props}>
      <ProductPurchasePanelContent />
    </ProductDetailsProvider>
  );
};

export default ProductDetails;
