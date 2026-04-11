export const prerender = false;

import type { APIRoute } from 'astro';
import type { HealthCheck } from '../../lib/types';
import { env } from 'cloudflare:workers';

const CRON_INTERVAL_MIN = 5;
const DEGRADED_AFTER_MIN = CRON_INTERVAL_MIN * 3;  // 15 min
const UNHEALTHY_AFTER_MIN = CRON_INTERVAL_MIN * 6; // 30 min

export const GET: APIRoute = async () => {
  const health: HealthCheck = {
    status: 'healthy',
    lastPollSuccess: '',
    dataAge: 0,
    issues: [],
    services: {
      database: 'online',
      pkpApi: 'online',
      stripe: 'online',
    },
  };

  try {
    await env.DB.prepare('SELECT 1').first();
  } catch {
    health.services.database = 'offline';
    health.issues.push('Database connection failed');
    health.status = 'unhealthy';
  }

  try {
    const cached = await env.DELAYS_KV.get('stats:today', 'json') as
      | { timestamp?: string; totalTrains?: number }
      | null;

    if (!cached?.timestamp) {
      health.services.pkpApi = 'offline';
      health.issues.push('No stats:today in KV — cron has never written');
      health.status = 'unhealthy';
    } else {
      const ageMs = Date.now() - new Date(cached.timestamp).getTime();
      const ageMinutes = Math.max(0, Math.floor(ageMs / 60_000));
      health.dataAge = ageMinutes;
      health.lastPollSuccess = cached.timestamp;

      if (ageMinutes >= UNHEALTHY_AFTER_MIN) {
        health.services.pkpApi = 'offline';
        health.issues.push(`Last poll was ${ageMinutes} min ago`);
        health.status = 'unhealthy';
      } else if (ageMinutes >= DEGRADED_AFTER_MIN) {
        health.services.pkpApi = 'degraded';
        health.issues.push(`Last poll was ${ageMinutes} min ago`);
        if (health.status === 'healthy') health.status = 'degraded';
      }

      if (cached.totalTrains != null && cached.totalTrains < 100) {
        health.services.pkpApi = 'degraded';
        health.issues.push(`Only ${cached.totalTrains} trains in last poll`);
        if (health.status === 'healthy') health.status = 'degraded';
      }
    }
  } catch (err) {
    health.services.pkpApi = 'offline';
    health.issues.push('Failed to read stats:today from KV');
    health.status = 'unhealthy';
  }

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    health.services.stripe = 'degraded';
    health.issues.push('Incomplete Stripe configuration');
    if (health.status === 'healthy') health.status = 'degraded';
  }

  return new Response(JSON.stringify(health), {
    status: health.status === 'unhealthy' ? 503 : 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${health.status === 'healthy' ? 60 : 30}`,
    },
  });
};
