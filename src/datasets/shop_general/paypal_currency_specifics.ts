const zeroDecimalCurrencyCodes = [
  'JPY', // Japanese Yen
  'KRW', // South Korean Won
  'CLP', // Chilean Peso
  'DJF', // Djibouti Franc
  'PYG', // Paraguayan Guarani
  'RWF', // Rwandan Franc
  'UGX', // Ugandan Shilling
  'VUV', // Vanuatu Vatu
  'VND', // Vietnamese Dong
  'BIF', // Burundian Franc
  'KMF', // Comorian Franc
  'XAF', // Central African CFA franc
  'XOF', // West African CFA franc
  'XPF', // CFP franc
  'GNF', // Guinean Franc
  'LAK', // Lao Kip (listed in a section on decimal places, shows 0)
  'LBP', // Lebanese Pound (listed in a section on decimal places, shows 0)
  'MMK', // Myanmar Kyat
  'UZS', // Uzbekistan Som (listed in a section on decimal places, shows 0)
];

const currenciesWithNonDecimalSubdivisionCodes = [
  'MRU', // Mauritanian Ouguiya (the new code)
  'MGA', // Malagasy Ariary
];

// Combine the two lists for a comprehensive array of ISO 3-digit codes
export const currencyCodesWithoutDecimalPrecision = [
  ...currenciesWithNonDecimalSubdivisionCodes,
  ...zeroDecimalCurrencyCodes,
];

export const PAYPAL_CURRENCY_CODES = [
  'AUD', // Australian dollar
  'BRL', // Brazilian real
  'CAD', // Canadian dollar
  'CNY', // Chinese Renminbi
  'CZK', // Czech koruna
  'DKK', // Danish krone
  'EUR', // Euro
  'HKD', // Hong Kong dollar
  'HUF', // Hungarian forint
  'ILS', // Israeli new shekel
  'JPY', // Japanese yen
  'MYR', // Malaysian ringgit
  'MXN', // Mexican peso
  'TWD', // New Taiwan dollar
  'NZD', // New Zealand dollar
  'NOK', // Norwegian krone
  'PHP', // Philippine peso
  'PLN', // Polish złoty
  'GBP', // British pound sterling
  'RUB', // Russian ruble
  'SGD', // Singapore dollar
  'SEK', // Swedish krona
  'CHF', // Swiss franc
  'THB', // Thai baht
  'USD', // US dollar
] as const;

/** PayPal-specific zero-digit currencies. Decimal amounts are rejected by PayPal for these. */
export const PAYPAL_ZERO_DIGIT_CURRENCY_CODES = ['HUF', 'JPY', 'TWD'] as const;
