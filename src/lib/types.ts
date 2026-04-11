/**
 * Shared type definitions for niejedzie.pl
 * Single source of truth for data structures used across API, workers, and frontend
 */

// ──────────────────────────────────────────────────────────────────────────────
// Core Train Data Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ApiStation {
  stationId: number;
  stationName: string;
  sequenceNumber: number;
  plannedArrival: string | null;
  plannedDeparture: string | null;
  actualArrival: string | null;
  actualDeparture: string | null;
  arrivalDelayMinutes: number | null;
  departureDelayMinutes: number | null;
  isConfirmed: boolean;
  isCancelled: boolean;
  // Enhanced data quality fields
  confidence?: 'high' | 'medium' | 'low' | 'estimated';
  isEstimated?: boolean;
  dataSource?: 'portal_pasazera_detail' | 'portal_pasazera_summary' | 'route_completion' | 'auto_healing';
  appliedFixes?: string[];
}

export interface ApiTrain {
  scheduleId: number;
  orderId: number;
  trainNumber?: string;
  carrier?: string;
  category?: string;
  routeStart?: string;
  routeEnd?: string;
  operatingDate: string;
  stations: ApiStation[];
  // Metadata
  totalStations?: number;
  dataQuality?: DataQuality;
}

// ──────────────────────────────────────────────────────────────────────────────
// Data Quality & Monitoring Types
// ──────────────────────────────────────────────────────────────────────────────

export interface DataQuality {
  overallConfidence: number; // 0-100
  dataFreshness: number; // minutes since last update
  sourceReliability: number; // 0-100
  detectedAnomalies: string[];
  qualityScore: number; // computed overall score 0-100
  lastUpdated: string; // ISO timestamp
}

export interface QualityWarning {
  type: 'missing_data' | 'suspicious_times' | 'delay_jumps' | 'incomplete_route' | 'stale_data';
  severity: 'info' | 'warning' | 'error';
  message: string;
  affectedStations?: number;
  trainNumber?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Dashboard & Stats Types
// ──────────────────────────────────────────────────────────────────────────────

export interface TodayStats {
  totalTrains: number;
  punctualityPercent: number;
  avgDelayMinutes: number;
  cancelledTrains: number;
  mostDelayedRoute?: string;
  dataFreshness: number; // minutes since last update
}

export interface HourlyDelay {
  hour: number;
  avgDelay: number;
  trainCount: number;
  punctualityPercent: number;
}

export interface DelayedTrain {
  trainNumber: string;
  carrier: string;
  route: string;
  delayMinutes: number;
  lastStation?: string;
  scheduleId: number;
  orderId: number;
}

export interface TodayResponse {
  stats: TodayStats;
  hourlyDelays: HourlyDelay[];
  topDelayed: DelayedTrain[];
  disruptions: DisruptionInfo[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Disruption Types
// ──────────────────────────────────────────────────────────────────────────────

export interface DisruptionInfo {
  id: string;
  typeCode: string;
  typeName: string;
  affectedStations: string[];
  message: string;
  severity: 'info' | 'warning' | 'critical';
  isActive: boolean;
  startTime?: string;
  estimatedEndTime?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Search & Autocomplete Types
// ──────────────────────────────────────────────────────────────────────────────

export interface TrainSearchResult {
  trainNumber: string;
  carrier: string;
  category: string;
  routeStart: string;
  routeEnd: string;
  operatingDate: string;
  totalStations: number;
  stations: ApiStation[];
  dataQuality: DataQuality;
  qualityWarnings: QualityWarning[];
  hiddenStations: number; // stations hidden due to low confidence
}

export interface AutocompleteResult {
  value: string;
  label: string;
  type: 'station' | 'train' | 'city';
  carrier?: string;
  category?: string;
  subtitle?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Payment & Monitoring Types
// ──────────────────────────────────────────────────────────────────────────────

export interface MonitoringSession {
  id: string;
  trainA: string;
  trainB: string;
  transferStation: string;
  operatingDate: string;
  status: 'pending' | 'active' | 'cancelled' | 'expired';
  paymentStatus: 'pending' | 'completed' | 'failed';
  paymentType: 'one_time' | 'subscription';
  stripeSessionId?: string;
  stripeCustomerId?: string;
  createdAt: string;
  lastChecked?: string;
  alertsSent?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Error Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
  message?: string;
  details?: any;
  timestamp?: string;
}

export interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastPollSuccess: string; // ISO timestamp from stats:today KV
  dataAge: number; // minutes since last cron poll wrote stats:today
  issues: string[];
  services: {
    database: 'online' | 'offline' | 'degraded';
    pkpApi: 'online' | 'offline' | 'degraded';
    stripe: 'online' | 'offline' | 'degraded';
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants & Enums
// ──────────────────────────────────────────────────────────────────────────────

export const TRAIN_OPERATORS = {
  'IC': { name: 'PKP Intercity', color: '#0066cc' },
  'TLK': { name: 'PKP Intercity', color: '#0066cc' },
  'EIC': { name: 'PKP Intercity', color: '#003d7a' },
  'EIP': { name: 'PKP Intercity', color: '#003d7a' },
  'KD': { name: 'Koleje Dolnośląskie', color: '#005c29' },
  'KW': { name: 'Koleje Wielkopolskie', color: '#bf2c26' },
  'KS': { name: 'Koleje Śląskie', color: '#ffcd00' },
  'SKM': { name: 'SKM Trójmiasto', color: '#0066ff' },
  'WKD': { name: 'WKD', color: '#ee3124' },
  'PR': { name: 'POLREGIO', color: '#b50000' },
  'REG': { name: 'POLREGIO', color: '#b50000' },
  'OS': { name: 'POLREGIO', color: '#b50000' },
  'R': { name: 'POLREGIO', color: '#b50000' },
} as const;

export type OperatorCode = keyof typeof TRAIN_OPERATORS;

export const DATA_QUALITY_THRESHOLDS = {
  HIGH_CONFIDENCE: 85,
  MEDIUM_CONFIDENCE: 60,
  LOW_CONFIDENCE: 30,
  MAX_DATA_AGE_MINUTES: 10,
  MAX_STALE_AGE_MINUTES: 30,
} as const;

export const API_CACHE_TTL = {
  DELAYS_TODAY: 60, // 1 minute
  TRAIN_SEARCH: 30, // 30 seconds
  DISRUPTIONS: 120, // 2 minutes
  AUTOCOMPLETE: 300, // 5 minutes
  QUALITY: 30, // 30 seconds
} as const;