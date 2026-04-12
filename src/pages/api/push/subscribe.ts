/**
 * POST /api/push/subscribe
 * Stores a browser push subscription for a monitoring session.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request }) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const { sessionId, subscription } = await request.json();

    if (!sessionId || !subscription?.endpoint) {
      return new Response(
        JSON.stringify({ error: 'Missing sessionId or subscription' }),
        { status: 400, headers },
      );
    }

    await env.DB.prepare(
      `UPDATE monitoring_sessions SET push_subscription = ? WHERE id = ?`,
    ).bind(JSON.stringify(subscription), sessionId).run();

    return new Response(
      JSON.stringify({ success: true }),
      { headers },
    );
  } catch (err) {
    console.error('[push/subscribe] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to register subscription' }),
      { status: 500, headers },
    );
  }
};
