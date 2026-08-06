export interface BasicProductInterface {
  data: {
    _id: string;
    title: string;
    description: string;
    image: string;
    retail_price: string;
    slug: string;
    is_active?: boolean;
    is_deleted?: boolean;
    is_private?: boolean;
    is_taken_down?: boolean;
    approval_status?: string;
    status?: string;
  };
}

type AttributeBase<Name extends string, ValueType extends string> = {
  slug?: string;
  value: string;
  name: string;
  attribute?: {
    name: Name;
    value_type: ValueType;
  };
};

type VariantValueType = 'size' | 'color' | 'product' | 'label';

export type ProductAttribute = AttributeBase<'Product', VariantValueType> & {
  is_preselected?: boolean;
  position?: number;
  hide_storefront?: boolean;
};

type ClothingSizeSlug = 'xs' | 's' | 'm' | 'l' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';
export type ClothingSizeValue = Uppercase<ClothingSizeSlug>;

type AttrRequired<Name extends string, ValueType extends string, Value = string, Slug = string> = {
  slug: Slug;
  value: Value;
  name: Value;
  attribute: { name: Name; value_type: ValueType };
};

type AttrOptionalAttr<Name extends string, ValueType extends string, Value = string> = {
  slug?: string;
  value: Value;
  name: Value;
  attribute?: { name: Name; value_type: ValueType };
};

export type SizeAttribute = AttrRequired<'Size', 'size', ClothingSizeValue, ClothingSizeSlug>;
export type ColorAttribute = AttrOptionalAttr<'Color', 'color', string>;
export type LabelAttribute = AttrOptionalAttr<'label', 'label', string>;

export type ProductOption = SizeAttribute | ColorAttribute | ProductAttribute | LabelAttribute;

export type ProductVariantOptions = [ProductOption, ...ProductOption[]];

export interface ProductVariantsInterface {
  data: {
    _id: string;
    image_uris: string[];
    retail_price: number;
    is_default: boolean;
    title: string;
    options: ProductVariantOptions;
    sku: string;
    sku_seller?: string;
    product: string;
    is_active?: boolean;
    is_deleted?: boolean;
    is_hidden?: boolean;
    status?: string;
  }[];
}

export interface ProductResult {
  productMetaData: BasicProductInterface['data'];
  productVariants: ProductVariantsInterface['data'];
}

export function hasColorAndSize(options: ProductVariantOptions): boolean {
  const hasColor = options.some(
    (opt) =>
      !!opt.attribute &&
      typeof opt.attribute.name === 'string' &&
      opt.attribute.name.toLowerCase() === 'color',
  );
  const hasSize = options.some(
    (opt) =>
      !!opt.attribute &&
      typeof opt.attribute.name === 'string' &&
      opt.attribute.name.toLowerCase() === 'size',
  );
  return hasColor && hasSize;
}
