// Shared data fetching for SSR pages
// Fetches from our own API routes, returns typed data or null on failure

const BASE_URL = import.meta.env.PROD
  ? 'https://niejedzie.pl'
  : 'http://localhost:4321';

// --- Types ---

export interface TodayStats {
  totalTrains: number;
  punctuality: number;
  avgDelay: number;
  cancelled: number;
}

export interface HourlyDelay {
  hour: string;
  avgDelay: number;
}

export interface DelayedTrain {
  trainNumber: string;
  delay: number;
  route: string;
  station: string;
  carrier: string;
}

export interface TodayData {
  stats: TodayStats;
  hourlyDelays: HourlyDelay[];
  topDelayed: DelayedTrain[];
  disruptions: Disruption[];
}

export interface Disruption {
  id: number;
  typeCode: string;
  startStation: string;
  endStation: string;
  message: string;
}

export interface CityData {
  city: string;
  today: {
    trainCount: number;
    avgDelay: number;
    punctuality: number;
  };
  topDelayed: DelayedTrain[];
  history: { date: string; punctuality: number }[];
}

export interface MonthlyData {
  monthlyTrend: { month: string; punctuality: number }[];
  byOperator: { carrier: string; trainCount: number; avgDelay: number; punctuality: number }[];
  byCategory: { category: string; trainCount: number; avgDelay: number; punctuality: number }[];
}

// --- Fetch helpers ---

async function safeFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch (err) {
    console.error(`[fetch-data] Failed to fetch ${path}:`, err);
    return null;
  }
}

export async function fetchTodayDelays(): Promise<TodayData | null> {
  return safeFetch<TodayData>('/api/delays/today');
}

export async function fetchCityData(city: string): Promise<CityData | null> {
  return safeFetch<CityData>(`/api/city/${city}`);
}

export async function fetchDisruptions(): Promise<Disruption[] | null> {
  const data = await safeFetch<{ disruptions: Disruption[] }>('/api/disruptions');
  return data?.disruptions ?? null;
}

export async function fetchMonthlyStats(): Promise<MonthlyData | null> {
  return safeFetch<MonthlyData>('/api/stats/monthly');
}

// --- Defaults for empty state ---

export const EMPTY_TODAY: TodayData = {
  stats: { totalTrains: 0, punctuality: 0, avgDelay: 0, cancelled: 0 },
  hourlyDelays: [],
  topDelayed: [],
  disruptions: [],
};

export const EMPTY_CITY: CityData = {
  city: '',
  today: { trainCount: 0, avgDelay: 0, punctuality: 0 },
  topDelayed: [],
  history: [],
};
