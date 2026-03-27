import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;

export function getStripe(secretKey: string): Stripe {
  if (!stripeInstance) {
    stripeInstance = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return stripeInstance;
}
