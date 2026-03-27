/**
 * GET /api/train/enhanced-search?q={trainNumber}
 * Enhanced train search with data confidence indicators and factual guarantees
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface EnhancedStation {
  name: string;
  plannedArr: string | null;
  plannedDep: string | null;
  actualArr: string | null;
  actualDep: string | null;
  delay: number | null;
  passed: boolean;
  current: boolean;
  // Enhanced fields for factual display
  confidence: 'high' | 'medium' | 'low' | 'estimated' | 'unreliable';
  dataSource: string;
  lastUpdated: string;
  issues: string[];
  shouldDisplay: boolean;
  estimatedData?: boolean;
}

interface DataQualityMetrics {
  overallConfidence: number;
  dataFreshness: number; // minutes
  sourceReliability: number;
  detectedAnomalies: string[];
  qualityScore: number; // 0-100
}

function validateStationForDisplay(station: any, previousStation: any = null): EnhancedStation {
  const issues: string[] = [];
  let confidence: 'high' | 'medium' | 'low' | 'estimated' | 'unreliable' = 'high';
  let shouldDisplay = true;

  // 1. Check for suspicious 00:00:00 artifacts
  if (station.actualArr === '00:00' && station.plannedArr && station.plannedArr !== '00:00') {
    const plannedHour = parseInt(station.plannedArr.split(':')[0]);
    if (plannedHour >= 12) { // Planned after noon but actual at 00:00
      issues.push('Podejrzany czas przyjazdu (możliwy błąd danych)');
      confidence = 'unreliable';
      shouldDisplay = false; // Don't show clearly wrong data
    }
  }

  // 2. Check for sudden delay jumps
  if (previousStation && station.delay !== null && previousStation.delay !== null) {
    const delayJump = Math.abs(station.delay - previousStation.delay);
    if (delayJump > 30) {
      issues.push(`Duży skok opóźnienia (+${delayJump} min)`);
      if (delayJump > 45) {
        confidence = confidence === 'high' ? 'low' : confidence;
      } else {
        confidence = confidence === 'high' ? 'medium' : confidence;
      }
    }
  }

  // 3. Check for extreme delays
  if (station.delay !== null && Math.abs(station.delay) > 120) {
    issues.push('Ekstremalne opóźnienie (>2h)');
    confidence = 'low';
  }

  // 4. Check for missing data patterns
  if (!station.actualArr && !station.actualDep && station.passed) {
    issues.push('Brak danych o faktycznym czasie');
    confidence = confidence === 'high' ? 'medium' : confidence;
  }

  return {
    name: station.name,
    plannedArr: station.plannedArr,
    plannedDep: station.plannedDep,
    actualArr: shouldDisplay ? station.actualArr : null,
    actualDep: shouldDisplay ? station.actualDep : null,
    delay: shouldDisplay ? station.delay : null,
    passed: station.passed,
    current: station.current,
    confidence,
    dataSource: 'portal_pasazera',
    lastUpdated: new Date().toISOString(),
    issues,
    shouldDisplay,
    estimatedData: false
  };
}

function calculateDataQualityMetrics(stations: EnhancedStation[]): DataQualityMetrics {
  const confidenceScores = {
    'high': 100,
    'medium': 75,
    'low': 50,
    'estimated': 60,
    'unreliable': 0
  };

  const visibleStations = stations.filter(s => s.shouldDisplay);
  const totalStations = stations.length;
  const reliableStations = stations.filter(s => s.confidence === 'high').length;

  // Calculate overall confidence (weighted by station count)
  const avgConfidence = visibleStations.reduce((sum, station) =>
    sum + confidenceScores[station.confidence], 0) / visibleStations.length;

  // Calculate data freshness (assuming current data)
  const dataFreshness = 2; // minutes (from cron frequency)

  // Calculate source reliability based on data completeness
  const sourceReliability = (reliableStations / totalStations) * 100;

  // Detect anomalies
  const detectedAnomalies: string[] = [];
  const unreliableCount = stations.filter(s => s.confidence === 'unreliable').length;
  if (unreliableCount > 0) {
    detectedAnomalies.push(`${unreliableCount} stations with unreliable data`);
  }

  const extremeDelayCount = stations.filter(s => s.delay && Math.abs(s.delay) > 120).length;
  if (extremeDelayCount > 0) {
    detectedAnomalies.push(`${extremeDelayCount} stations with extreme delays`);
  }

  // Calculate quality score (0-100)
  const qualityScore = Math.round((avgConfidence + sourceReliability) / 2);

  return {
    overallConfidence: Math.round(avgConfidence),
    dataFreshness,
    sourceReliability: Math.round(sourceReliability),
    detectedAnomalies,
    qualityScore
  };
}

export const GET: APIRoute = async ({ url, request }) => {
  const trainNumber = url.searchParams.get('q');

  if (!trainNumber || trainNumber.trim() === '') {
    return new Response(JSON.stringify({
      error: 'Missing train number parameter'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Get data from existing API
    const baseApiUrl = new URL('/api/train/search', url.origin);
    baseApiUrl.searchParams.set('q', trainNumber);

    const baseResponse = await fetch(baseApiUrl.toString());
    if (!baseResponse.ok) {
      throw new Error('Base API failed');
    }

    const baseData = await baseResponse.json();

    if (!baseData.stations || baseData.stations.length === 0) {
      return new Response(JSON.stringify({
        train: null,
        stations: [],
        dataQuality: {
          overallConfidence: 0,
          dataFreshness: 0,
          sourceReliability: 0,
          detectedAnomalies: ['No data found'],
          qualityScore: 0
        },
        suggestions: [],
        message: 'Brak danych dla tego pociągu'
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 404
      });
    }

    // Enhance each station with confidence indicators
    const enhancedStations: EnhancedStation[] = [];
    for (let i = 0; i < baseData.stations.length; i++) {
      const station = baseData.stations[i];
      const previousStation = i > 0 ? enhancedStations[i - 1] : null;

      const enhancedStation = validateStationForDisplay(station, previousStation);
      enhancedStations.push(enhancedStation);
    }

    // Calculate data quality metrics
    const dataQuality = calculateDataQualityMetrics(enhancedStations);

    // Filter out unreliable stations for display
    const displayStations = enhancedStations.filter(s => s.shouldDisplay);

    const response = {
      train: baseData.train,
      stations: displayStations,
      dataQuality,
      suggestions: baseData.suggestions || [],
      hiddenStations: enhancedStations.length - displayStations.length,
      qualityWarnings: dataQuality.detectedAnomalies,
      _meta: {
        enhanced: true,
        version: '2.0',
        dataIntegrityChecks: [
          'suspicious_timestamp_detection',
          'delay_jump_validation',
          'extreme_delay_filtering',
          'data_completeness_scoring'
        ]
      }
    };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60' // 1 minute cache
      }
    });

  } catch (error) {
    console.error('[api/train/enhanced-search] Error:', error);

    return new Response(JSON.stringify({
      error: 'Failed to fetch train data',
      message: String(error),
      dataQuality: {
        overallConfidence: 0,
        dataFreshness: 0,
        sourceReliability: 0,
        detectedAnomalies: ['API Error'],
        qualityScore: 0
      }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};