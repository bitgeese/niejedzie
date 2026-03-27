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
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    let issues: QualityIssue[] = [];
    let issueCount = 0;

    // PHASE 3 FIX: Add real-time database quality checks
    const today = new Date().toISOString().split('T')[0];

    // Check for suspicious midnight times
    const midnightTimesQuery = await env.DB.prepare(`
      SELECT COUNT(*) as suspicious_count
      FROM delay_snapshots
      WHERE operating_date = ?
        AND (planned_arrival LIKE '%T00:00:00' OR actual_arrival LIKE '%T00:00:00')
        AND (planned_departure IS NOT NULL OR actual_departure IS NOT NULL)
    `).bind(today).first();

    const suspiciousCount = midnightTimesQuery?.suspicious_count || 0;
    if (suspiciousCount > 10) {
      issues.push({
        type: 'suspicious_midnight_times',
        severity: 'error',
        message: `Found ${suspiciousCount} stations with suspicious midnight times`,
        count: suspiciousCount,
        timestamp: new Date().toISOString()
      });
    }

    // Check time parsing success rate
    const timeParsingQuery = await env.DB.prepare(`
      SELECT
        COUNT(*) as total_stations,
        COUNT(CASE WHEN planned_arrival IS NULL AND planned_departure IS NULL
                    AND actual_arrival IS NULL AND actual_departure IS NULL THEN 1 END) as null_time_stations
      FROM delay_snapshots
      WHERE operating_date = ?
    `).bind(today).first();

    const totalStations = timeParsingQuery?.total_stations || 0;
    const nullTimeStations = timeParsingQuery?.null_time_stations || 0;
    const successRate = totalStations > 0 ? ((totalStations - nullTimeStations) / totalStations * 100) : 0;

    if (successRate < 90 && totalStations > 0) {
      issues.push({
        type: 'low_time_parsing_success',
        severity: 'warning',
        message: `Time parsing success rate: ${successRate.toFixed(1)}% (target: >90%)`,
        count: nullTimeStations,
        timestamp: new Date().toISOString()
      });
    }

    // Check for unrealistic delays (>2 hours)
    const extremeDelaysQuery = await env.DB.prepare(`
      SELECT COUNT(*) as extreme_delays
      FROM delay_snapshots ds
      WHERE operating_date = ?
        AND (arrival_delay > 120 OR departure_delay > 120)
    `).bind(today).first();

    const extremeDelays = extremeDelaysQuery?.extreme_delays || 0;
    if (extremeDelays > 5) {
      issues.push({
        type: 'extreme_delays',
        severity: 'warning',
        message: `Found ${extremeDelays} stations with delays >2 hours (possible parsing errors)`,
        count: extremeDelays,
        timestamp: new Date().toISOString()
      });
    }

    // Also check KV for cached quality issues from cron worker
    const qualityData = await env.DELAYS_KV.get('quality:issues', 'json') as {
      timestamp: string;
      issueCount: number;
      issues: QualityIssue[];
    } | null;

    if (qualityData?.issues) {
      issues = [...issues, ...qualityData.issues];
    }

    issueCount = issues.length;
    const lastCheck = new Date().toISOString();

    // Determine overall status based on issue severity
    const hasError = issues.some(i => i.severity === 'error');
    const hasCritical = issues.some(i => i.severity === 'critical');

    if (hasCritical) {
      status = 'critical';
    } else if (hasError) {
      status = 'degraded';
    } else if (issueCount > 0) {
      status = 'degraded';
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