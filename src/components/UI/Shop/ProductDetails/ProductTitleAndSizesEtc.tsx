import dynamic from 'next/dynamic';
import { useProductDetailsContext } from '.';
import { useCurrentVariant } from './currentVariantStore';
import { Suspense, useMemo } from 'react';
import { PriceSkeleton } from '../GlobalShopComponents/GlobalProductPrice';
import { Skeleton } from '../../primitives/skeleton';
import {
  ProductVariantsInterface,
  SizeAttribute,
  ColorAttribute,
  ProductVariantOptions,
} from '@/lib/merchizeStorefront/productTypes';
import styles from './ProductDetails.module.css';

const AddToCart = dynamic(() => import('./AddToCart').then((mod) => mod.AddToCart));
const BuyNow = dynamic(() => import('./BuyNow').then((mod) => mod.BuyNow));
const DeliveryandPaymentsBanner = dynamic(() =>
  import('./DeliveryandPaymentsBanner').then((mod) => mod.DeliveryandPaymentsBanner),
);
const VariantAttributeSelector = dynamic(() =>
  import('./VariantAttributeSelector').then((mod) => mod.default),
);
const GlobalProductPrice = dynamic(() =>
  import('../GlobalShopComponents/GlobalProductPrice').then((mod) => mod.default),
);

const getOptionsByAttribute = (variants: ProductVariantsInterface['data'], attrName: string) => [
  ...new Map(
    variants
      .flatMap((v) => v.options)
      .filter((o) => o.attribute?.name.toLowerCase() === attrName.toLowerCase())
      .map((o) => [o.value, o]),
  ).values(),
];

// Main Component
const ProductTitleAndSizesEtc = () => {
  // Hooks
  const productDetailsContext = useProductDetailsContext();
  const matchingVariant = useCurrentVariant((state) => state.matchingVariant);
  const metadata = productDetailsContext.productMetaData;
  const variantsAreLoading = productDetailsContext.variantLoadState === 'loading';
  const variantsFailed = productDetailsContext.variantLoadState === 'error';

  const { title, retail_price } = useMemo(() => {
    if (!matchingVariant) {
      return {
        title: metadata.title,
        retail_price: metadata.retail_price,
      };
    } else {
      return {
        title: metadata.title,
        retail_price: matchingVariant?.retail_price,
      };
    }
  }, [matchingVariant, metadata.retail_price, metadata.title]);

  const sizeAttrList = getOptionsByAttribute(
    productDetailsContext.productVariants,
    'size',
  ) as SizeAttribute[];
  const colorAttrList = getOptionsByAttribute(
    productDetailsContext.productVariants,
    'color',
  ) as ColorAttribute[];
  const labelAttrList = getOptionsByAttribute(
    productDetailsContext.productVariants,
    'label',
  ) as ProductVariantOptions[number][];

  //  JSX
  return (
    <div className='grid gap-4 lg:col-span-2 xl:col-span-1'>
      <div className={`${styles.productPanel} ${styles.spaceLarge}`}>
        <div className='space-y-3'>
          <h2 className='font-bold text-2xl'>{title}</h2>

          <div className='flex items-start gap-2'>
            <div className='space-y-3 cursor-pointer'>
              <h3 className={styles.priceHeading}>
                <Suspense fallback={<PriceSkeleton className='h-5 w-24' />}>
                  <GlobalProductPrice usdAmount={Number(retail_price)} />
                </Suspense>
              </h3>

              {/* Stars */}
            </div>
          </div>
        </div>

        {/* Size, Color and Label Selectors */}
        {variantsAreLoading ? (
          <div className='space-y-3' aria-live='polite' aria-busy='true'>
            <Skeleton className='h-5 w-28 bg-white/15' />
            <div className='grid grid-cols-4 gap-2'>
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className='h-10 bg-white/10' />
              ))}
            </div>
          </div>
        ) : variantsFailed ? (
          <p className='rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-white/80'>
            Product options could not load. Refresh the page and try again.
          </p>
        ) : productDetailsContext.productVariants.length === 0 ? (
          <p className='rounded-lg border border-amber-300/30 bg-amber-950/20 p-3 text-sm text-amber-100'>
            This item has no production-ready options right now.
          </p>
        ) : (
          <>
            {sizeAttrList.length > 0 && (
              <VariantAttributeSelector title='Size:' attribute='size' options={sizeAttrList} />
            )}
            {colorAttrList.length > 0 && (
              <VariantAttributeSelector title='Colors:' attribute='color' options={colorAttrList} />
            )}
            {labelAttrList.length > 0 && (
              <VariantAttributeSelector title='Label:' attribute='label' options={labelAttrList} />
            )}
          </>
        )}

        {/* Add to Cart and Buy Now buttons */}
        <div className='space-y-4'>
          <AddToCart
            variants={productDetailsContext.productVariants}
            isLoadingVariants={variantsAreLoading}
          />

          <BuyNow />
        </div>
      </div>

      <DeliveryandPaymentsBanner />
    </div>
  );
};

export default ProductTitleAndSizesEtc;
