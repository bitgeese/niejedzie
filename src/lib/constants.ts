// Single source of truth for prices and product config
// Change here → changes everywhere across the site

export const PRICES = {
  ONE_TIME_PLN: 5,
  MONTHLY_PLN: 15,
  // Formatted strings
  ONE_TIME: '5 zł',
  MONTHLY: '15 zł',
  MONTHLY_PER: '15 zł/msc',
} as const;

export const PRODUCT = {
  NAME: 'niejedzie.pl',
  TAGLINE: 'Monitor przesiadek PKP',
  DOMAIN: 'niejedzie.pl',
  URL: 'https://niejedzie.pl',
} as const;
