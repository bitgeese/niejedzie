export const prerender = false;

import type { APIRoute } from 'astro';
import type { HealthCheck } from '../../lib/types';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ request }) => {
  try {
    const health: HealthCheck = {
      status: 'healthy',
      lastScrapeSuccess: '',
      dataAge: 0,
      issues: [],
      services: {
        database: 'online',
        scraper: 'online',
        brightData: 'not_configured',
        stripe: 'online',
      }
    };

    // Check database connectivity
    try {
      const dbTest = await env.DB.prepare('SELECT 1 as test').first();
      health.services.database = dbTest ? 'online' : 'offline';
    } catch (err) {
      health.services.database = 'offline';
      health.issues.push('Database connection failed');
      health.status = 'degraded';
    }

    // Check recent scraper activity
    try {
      const today = new Date().toISOString().split('T')[0];
      const recentData = await env.DB.prepare(`
        SELECT MAX(recorded_at) as last_recorded, COUNT(*) as station_count
        FROM delay_snapshots
        WHERE operating_date = ?
      `).bind(today).first();

      if (recentData?.last_recorded) {
        const lastRecorded = new Date(recentData.last_recorded);
        const ageMinutes = Math.floor((Date.now() - lastRecorded.getTime()) / (1000 * 60));
        health.dataAge = ageMinutes;
        health.lastScrapeSuccess = recentData.last_recorded;

        if (ageMinutes > 10) {
          health.services.scraper = 'degraded';
          health.issues.push(`Data is ${ageMinutes} minutes old`);
          health.status = 'degraded';
        }

        if (ageMinutes > 30) {
          health.services.scraper = 'offline';
          health.issues.push('Scraper appears to be down');
          health.status = 'unhealthy';
        }

        if (recentData.station_count < 50) {
          health.services.scraper = 'degraded';
          health.issues.push(`Low station count: ${recentData.station_count}`);
          health.status = 'degraded';
        }
      } else {
        health.services.scraper = 'offline';
        health.issues.push('No data found for today');
        health.status = 'unhealthy';
      }
    } catch (err) {
      health.services.scraper = 'offline';
      health.issues.push('Failed to check scraper status');
      health.status = 'degraded';
    }

    // Check for Bright Data API key
    if (env.BRIGHT_DATA_API_KEY) {
      health.services.brightData = 'online';
    } else {
      health.services.brightData = 'not_configured';
    }

    // Check Stripe configuration
    try {
      if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
        health.services.stripe = 'online';
      } else {
        health.services.stripe = 'degraded';
        health.issues.push('Incomplete Stripe configuration');
      }
    } catch (err) {
      health.services.stripe = 'offline';
      health.issues.push('Stripe configuration error');
    }

    // Data quality checks
    try {
      const qualityChecks = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_stations,
          SUM(CASE WHEN planned_arrival IS NULL AND planned_departure IS NULL
                   AND actual_arrival IS NULL AND actual_departure IS NULL THEN 1 ELSE 0 END) as null_stations,
          SUM(CASE WHEN actual_arrival LIKE '%T00:00:00%'
                   AND planned_arrival NOT LIKE '%T00:00:00%' THEN 1 ELSE 0 END) as suspicious_midnight
        FROM delay_snapshots
        WHERE operating_date = ?
      `).bind(new Date().toISOString().split('T')[0]).first();

      if (qualityChecks) {
        const nullPercent = (qualityChecks.null_stations / qualityChecks.total_stations) * 100;
        const midnightPercent = (qualityChecks.suspicious_midnight / qualityChecks.total_stations) * 100;

        if (nullPercent > 20) {
          health.issues.push(`High null data rate: ${nullPercent.toFixed(1)}%`);
          health.status = 'degraded';
        }

        if (midnightPercent > 5) {
          health.issues.push(`Suspicious midnight times: ${midnightPercent.toFixed(1)}%`);
          health.status = 'degraded';
        }
      }
    } catch (err) {
      health.issues.push('Quality check failed');
    }

    // Set cache headers
    const cacheTime = health.status === 'healthy' ? 60 : 30; // Cache less when unhealthy

    return new Response(JSON.stringify(health), {
      status: health.status === 'unhealthy' ? 503 : 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${cacheTime}`,
      },
    });

  } catch (err) {
    console.error('[api/health] Error:', err);

    const errorHealth: HealthCheck = {
      status: 'unhealthy',
      lastScrapeSuccess: '',
      dataAge: -1,
      issues: ['Health check failed'],
      services: {
        database: 'offline',
        scraper: 'offline',
        brightData: 'not_configured',
        stripe: 'offline',
      }
    };

    return new Response(JSON.stringify(errorHealth), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  }
};