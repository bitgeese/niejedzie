/**
 * GET /api/quality
 * Returns current data quality status and issues.
 * Used for monitoring dashboard and alerts.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface QualityIssue {
  type: string;
  severity: 'warning' | 'error' | 'critical';
  message: string;
  count?: number;
  timestamp: string;
}

interface QualityResponse {
  status: 'healthy' | 'degraded' | 'critical';
  lastCheck: string | null;
  issueCount: number;
  issues: QualityIssue[];
}

const CACHE_TTL = 60; // 1 min cache

export const GET: APIRoute = async () => {
  try {
    // Check KV for cached quality issues
    const qualityData = await env.DELAYS_KV.get('quality:issues', 'json') as {
      timestamp: string;
      issueCount: number;
      issues: QualityIssue[];
    } | null;

    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    let issues: QualityIssue[] = [];
    let lastCheck: string | null = null;
    let issueCount = 0;

    if (qualityData) {
      issues = qualityData.issues || [];
      issueCount = qualityData.issueCount || 0;
      lastCheck = qualityData.timestamp;

      // Determine overall status based on issue severity
      const hasError = issues.some(i => i.severity === 'error');
      const hasCritical = issues.some(i => i.severity === 'critical');

      if (hasCritical) {
        status = 'critical';
      } else if (hasError || issueCount > 0) {
        status = 'degraded';
      }
    }

    const response: QualityResponse = {
      status,
      lastCheck,
      issueCount,
      issues,
    };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch (err) {
    console.error('[api/quality] Error:', err);

    return new Response(JSON.stringify({
      error: 'Failed to fetch quality data',
      message: String(err),
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  }
};