export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getStripe } from '../../../lib/stripe';

export const POST: APIRoute = async ({ request }) => {
  const stripe = getStripe(env.STRIPE_SECRET_KEY);
  const body = await request.text(); // RAW body — critical for signature verification
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    console.error('[webhook] Signature verification failed:', err.message);
    return new Response('Invalid signature', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const sessionId = session.metadata?.sessionId;

        if (sessionId) {
          await env.DB.prepare(`
            UPDATE monitoring_sessions
            SET payment_status = 'completed',
                status = 'active',
                stripe_customer_id = ?,
                last_checked = datetime('now')
            WHERE stripe_session_id = ?
          `).bind(
            session.customer || '',
            session.id
          ).run();

          console.log(`[webhook] Payment completed for session ${sessionId}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        if (customerId) {
          await env.DB.prepare(`
            UPDATE monitoring_sessions
            SET status = 'cancelled'
            WHERE stripe_customer_id = ? AND payment_type = 'subscription'
          `).bind(customerId).run();

          console.log(`[webhook] Subscription cancelled for customer ${customerId}`);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error('[webhook] Handler error:', err.message);
    // Return 200 anyway — don't retry on handler errors
  }

  return new Response('OK', { status: 200 });
};
