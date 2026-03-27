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

// Train operator mapping for UI badges
export const TRAIN_OPERATORS = {
  // National carriers
  IC: { name: 'PKP Intercity', type: 'national', color: 'red' },

  // Regional carriers
  PR: { name: 'PolRegio', type: 'regional', color: 'blue' },
  KD: { name: 'Koleje Dolnośląskie', type: 'regional', color: 'blue' },
  KS: { name: 'Koleje Śląskie', type: 'regional', color: 'blue' },
  KW: { name: 'Koleje Wielkopolskie', type: 'regional', color: 'blue' },
  LKA: { name: 'Łódzka Kolej Aglomeracyjna', type: 'regional', color: 'blue' },
  KML: { name: 'Koleje Małopolskie', type: 'regional', color: 'blue' },

  // Local/metro carriers
  KM: { name: 'Koleje Mazowieckie', type: 'local', color: 'green' },
  SKM: { name: 'SKM Trójmiasto', type: 'local', color: 'green' },
  SKMT: { name: 'SKM Warszawa', type: 'local', color: 'green' },
  WKD: { name: 'WKD', type: 'local', color: 'green' },

  // Private operators
  AR: { name: 'Arriva RP', type: 'private', color: 'purple' },
  RJ: { name: 'RegioJet', type: 'private', color: 'purple' },
  LEO: { name: 'Leo Express', type: 'private', color: 'purple' },

  // Default/unknown
  UNKNOWN: { name: 'Nieznany przewoźnik', type: 'unknown', color: 'gray' },
} as const;

export type OperatorCode = keyof typeof TRAIN_OPERATORS;
