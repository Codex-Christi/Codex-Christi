import Categories from '@/components/UI/Shop/Index/Categories';
// import SpecialDeals from '@/components/UI/Shop/Index/SpecialDeals';
import { FC } from 'react';
import CustomShopLink from '@/components/UI/Shop/HelperComponents/CustomShopLink';
import dynamic from 'next/dynamic';

const Deals = dynamic(() => import('@/components/UI/Shop/Index/Deals'));

export const revalidate = 3600;

const Shop: FC = () => {
  return (
    <>
      <aside
        aria-label='Shop alpha notice'
        className='mx-2 mt-4 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-center text-sm leading-6 text-amber-50 md:mx-5 lg:mx-6'
      >
        <span className='font-semibold text-amber-200'>Shop alpha:</span>{' '}
        Some storefront features are still being completed and may not work fully. Orders placed
        through checkout are real and made to order.
      </aside>

      <Deals />

      <div className='relative px-2 py-12 md:px-[20px] lg:px-[24px] space-y-12'>
        <div className='bg-[linear-gradient(90deg,_#FFFFFF_0%,_#E6F3FF_100%)] md:rounded-full p-4 flex flex-wrap items-center gap-4 text-[#0085FF] text-center md:text-left'>
          <div className='flex items-center mx-auto md:mx-0'>
            <CustomShopLink href='' aria-label='Give us a call'>
              <svg width='80' height='80' viewBox='0 0 113 113' fill='none'>
                <g filter='url(#filter0_d_634_1496)'>
                  <rect
                    x='20.5684'
                    y='20.8599'
                    width='72'
                    height='72'
                    rx='36'
                    fill='white'
                    shapeRendering='crispEdges'
                  />
                  <path
                    d='M51.6623 40.1503L53.2849 43.0576C54.7491 45.6813 54.1613 49.1231 51.8551 51.4294C51.8551 51.4294 49.0581 54.2269 54.1296 59.2986C59.1996 64.3686 61.9988 61.5731 61.9988 61.5731C64.3051 59.2669 67.7468 58.6791 70.3706 60.1434L73.2778 61.7659C77.2398 63.9769 77.7076 69.5328 74.2253 73.0153C72.1328 75.1078 69.5693 76.7361 66.7356 76.8433C61.9654 77.0243 53.8641 75.8171 45.7376 67.6906C37.6112 59.5641 36.4039 51.4629 36.5847 46.6926C36.6922 43.8589 38.3204 41.2954 40.4129 39.2029C43.8953 35.7206 49.4513 36.1885 51.6623 40.1503Z'
                    fill='#0085FF'
                  />
                </g>
                <defs>
                  <filter
                    id='filter0_d_634_1496'
                    x='0.568359'
                    y='0.859863'
                    width='112'
                    height='112'
                    filterUnits='userSpaceOnUse'
                    colorInterpolationFilters='sRGB'
                  >
                    <feFlood floodOpacity='0' result='BackgroundImageFix' />
                    <feColorMatrix
                      in='SourceAlpha'
                      type='matrix'
                      values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0'
                      result='hardAlpha'
                    />
                    <feOffset />
                    <feGaussianBlur stdDeviation='10' />
                    <feComposite in2='hardAlpha' operator='out' />
                    <feColorMatrix
                      type='matrix'
                      values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0'
                    />
                    <feBlend
                      mode='normal'
                      in2='BackgroundImageFix'
                      result='effect1_dropShadow_634_1496'
                    />
                    <feBlend
                      mode='normal'
                      in='SourceGraphic'
                      in2='effect1_dropShadow_634_1496'
                      result='shape'
                    />
                  </filter>
                </defs>
              </svg>
            </CustomShopLink>

            <CustomShopLink href='' aria-label='Send us a mail'>
              <svg width='80' height='80' viewBox='0 0 113 113' fill='none'>
                <g filter='url(#filter0_d_634_1510)'>
                  <rect
                    x='20.5684'
                    y='20.8599'
                    width='72'
                    height='72'
                    rx='36'
                    fill='white'
                    shapeRendering='crispEdges'
                  />
                  <path
                    fillRule='evenodd'
                    clipRule='evenodd'
                    d='M39.9709 46.7754C40.1209 46.3899 40.3489 46.0359 40.6474 45.7389C41.2099 45.1749 41.9734 44.8599 42.7684 44.8599H70.3682C71.1631 44.8599 71.9266 45.1749 72.4891 45.7389C72.7876 46.0374 73.0171 46.3914 73.1656 46.7769L56.9014 58.1589C56.7184 58.2609 56.5009 58.2609 56.3224 58.1649C56.3134 58.1604 43.2096 49.0313 39.9709 46.7754ZM73.3683 49.5638V65.8599C73.3683 66.6549 73.0533 67.4184 72.4893 67.9809C71.9268 68.5449 71.1633 68.8599 70.3683 68.8599H42.7685C41.9735 68.8599 41.21 68.5449 40.6476 67.9809C40.0835 67.4184 39.7686 66.6549 39.7686 65.8599V49.5581L54.9768 60.1541C54.9963 60.1676 55.0158 60.1796 55.0353 60.1916C56.0012 60.7856 57.2192 60.7841 58.1837 60.1871C58.2032 60.1751 58.2212 60.1631 58.2407 60.1511L73.3683 49.5638Z'
                    fill='#0085FF'
                  />
                </g>
                <defs>
                  <filter
                    id='filter0_d_634_1510'
                    x='0.568359'
                    y='0.859863'
                    width='112'
                    height='112'
                    filterUnits='userSpaceOnUse'
                    colorInterpolationFilters='sRGB'
                  >
                    <feFlood floodOpacity='0' result='BackgroundImageFix' />
                    <feColorMatrix
                      in='SourceAlpha'
                      type='matrix'
                      values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0'
                      result='hardAlpha'
                    />
                    <feOffset />
                    <feGaussianBlur stdDeviation='10' />
                    <feComposite in2='hardAlpha' operator='out' />
                    <feColorMatrix
                      type='matrix'
                      values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0'
                    />
                    <feBlend
                      mode='normal'
                      in2='BackgroundImageFix'
                      result='effect1_dropShadow_634_1510'
                    />
                    <feBlend
                      mode='normal'
                      in='SourceGraphic'
                      in2='effect1_dropShadow_634_1510'
                      result='shape'
                    />
                  </filter>
                </defs>
              </svg>
            </CustomShopLink>
          </div>

          <div>
            <p className='font-bold text-2xl'>Call Us / Email Us</p>

            <p>
              to customize anything. from{' '}
              <span className='font-medium'>T-shirts, Hoodies, Mugs</span> to just anything.
            </p>
          </div>
        </div>

        <Categories />

        {/* <SpecialDeals /> */}
      </div>
    </>
  );
};

export default Shop;
