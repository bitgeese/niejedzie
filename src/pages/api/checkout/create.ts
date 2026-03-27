export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getStripe } from '../../../lib/stripe';
import { PRICES } from '../../../lib/constants';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { mode, trainA, trainB, transferStation, operatingDate } = body;

    if (!mode || !['payment', 'subscription'].includes(mode)) {
      return Response.json({ error: 'Invalid mode' }, { status: 400 });
    }

    const stripe = getStripe(env.STRIPE_SECRET_KEY);
    const baseUrl = 'https://niejedzie.pl';

    // Generate a session ID for tracking
    const sessionId = crypto.randomUUID();

    // Create Stripe Checkout session
    // BLIK + P24 only work for one-time payments, not subscriptions
    const paymentMethods = mode === 'payment'
      ? ['card', 'blik', 'p24']
      : ['card'];

    const checkoutParams: any = {
      payment_method_types: paymentMethods,
      success_url: `${baseUrl}/sukces?session_id=${sessionId}`,
      cancel_url: `${baseUrl}/wynik`,
      locale: 'pl',
      metadata: {
        sessionId,
        trainA: trainA || '',
        trainB: trainB || '',
        transferStation: transferStation || '',
        operatingDate: operatingDate || '',
      },
    };

    if (mode === 'payment') {
      checkoutParams.mode = 'payment';
      checkoutParams.line_items = [{
        price_data: {
          currency: 'pln',
          product_data: {
            name: 'Monitor przesiadki — jednorazowy',
            description: trainA && trainB
              ? `${trainA} → ${transferStation} → ${trainB}`
              : 'Jednorazowy monitoring przesiadki',
          },
          unit_amount: PRICES.ONE_TIME_PLN * 100, // PLN in grosze
        },
        quantity: 1,
      }];
    } else {
      checkoutParams.mode = 'subscription';
      checkoutParams.line_items = [{
        price: env.STRIPE_PRICE_MONTHLY, // Pre-created price ID
        quantity: 1,
      }];
    }

    const session = await stripe.checkout.sessions.create(checkoutParams);

    // Create pending monitoring session in D1
    await env.DB.prepare(`
      INSERT INTO monitoring_sessions (id, push_subscription, train_a_schedule_id, train_a_order_id,
        transfer_station_id, train_b_schedule_id, train_b_order_id, operating_date,
        status, stripe_session_id, payment_status, payment_type)
      VALUES (?, '', 0, 0, 0, 0, 0, ?, 'pending', ?, 'pending', ?)
    `).bind(
      sessionId,
      operatingDate || new Date().toISOString().split('T')[0],
      session.id,
      mode === 'payment' ? 'one_time' : 'subscription'
    ).run();

    return Response.json({ url: session.url });
  } catch (err: any) {
    console.error('[checkout] Error:', err.message, err.stack);
    return Response.json({
      error: 'Checkout failed',
      detail: err.message,
      hasKey: !!env.STRIPE_SECRET_KEY,
      hasPrice: !!env.STRIPE_PRICE_MONTHLY,
    }, { status: 500 });
  }
};
