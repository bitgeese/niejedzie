import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;

/**
 * Get configured Stripe instance with validation
 * @param secretKey - Stripe secret key from environment
 * @returns Configured Stripe instance
 * @throws Error if secret key is missing or invalid format
 */
export function getStripe(secretKey: string): Stripe {
  // Validate secret key format
  if (!secretKey || typeof secretKey !== 'string') {
    throw new Error('STRIPE_SECRET_KEY not configured. Run: wrangler secret put STRIPE_SECRET_KEY');
  }

  if (!secretKey.startsWith('sk_test_') && !secretKey.startsWith('sk_live_')) {
    throw new Error(`Invalid STRIPE_SECRET_KEY format. Expected 'sk_test_' or 'sk_live_' prefix, got: ${secretKey.substring(0, 10)}...`);
  }

  if (!stripeInstance) {
    stripeInstance = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return stripeInstance;
}
