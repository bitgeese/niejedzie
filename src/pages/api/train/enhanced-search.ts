export const prerender = false;

import type { APIRoute } from 'astro';
import type { TrainSearchResult, DataQuality, QualityWarning, ApiStation } from '../../../lib/types';
import { DATA_QUALITY_THRESHOLDS } from '../../../lib/types';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get('q')?.trim();

  if (!searchQuery) {
    return new Response(JSON.stringify({
      error: 'Brak zapytania',
      detail: 'Podaj numer pociągu do wyszukania'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const operatingDate = new Date().toISOString().split('T')[0];

    // Search for trains matching the query
    const trainRows = await env.DB.prepare(`
      SELECT schedule_id, order_id, train_number, carrier, category, route_start, route_end
      FROM trains
      WHERE train_number LIKE ?
      ORDER BY
        CASE WHEN train_number = ? THEN 0 ELSE 1 END,
        LENGTH(train_number) ASC,
        train_number ASC
      LIMIT 5
    `).bind(`%${searchQuery}%`, searchQuery).all();

    if (!trainRows.results?.length) {
      return new Response(JSON.stringify({
        error: 'Nie znaleziono pociągu',
        detail: `Brak pociągu o numerze "${searchQuery}"`
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Return simplified result for now
    const train = trainRows.results[0];
    return new Response(JSON.stringify({
      trainNumber: train.train_number,
      carrier: train.carrier || 'Unknown',
      dataQuality: { overallConfidence: 75, qualityScore: 75 },
      stations: []
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });

  } catch (err) {
    console.error('[api/train/enhanced-search] Error:', err);
    return new Response(JSON.stringify({
      error: 'Błąd wyszukiwania',
      code: 'SEARCH_ERROR'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
