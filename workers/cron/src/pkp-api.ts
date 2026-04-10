// pkp-api.ts — Typed PKP PLK Open Data API client
//
// Standard tier: 500 req/hr, 5,000 req/day
// Base URL: https://pdp-api.plk-sa.pl

const PKP_API_BASE = "https://pdp-api.plk-sa.pl";

// ---------------------------------------------------------------------------
// Types — matching Swagger DTOs
// ---------------------------------------------------------------------------

export interface OperationStationDto {
  stationId: number;
  plannedSequenceNumber: number | null;
  actualSequenceNumber: number;
  plannedArrival: string | null;
  plannedDeparture: string | null;
  actualArrival: string | null;
  actualDeparture: string | null;
  arrivalDelayMinutes?: number;
  departureDelayMinutes?: number;
  isConfirmed?: boolean;
  isCancelled?: boolean;
}

export interface TrainOperationDto {
  scheduleId: number;
  orderId: number;
  trainOrderId: number;
  operatingDate: string;
  trainStatus: string | null;
  stations: OperationStationDto[];
}

export interface OperationsResponse {
  generatedAt: string;
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasNextPage: boolean;
  };
  trains: TrainOperationDto[];
  stations: Record<string, string>;
}

export interface StatisticsResponse {
  generatedAt: string;
  date: string;
  totalTrains: number;
  notStarted: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  partialCancelled: number;
}

export interface ScheduleStationDto {
  stationId: number;
  orderNumber: number;
  arrivalTime?: string;
  departureTime?: string;
  departureTrainNumber?: string;
  arrivalTrainNumber?: string;
  arrivalCommercialCategory?: string;
  departureCommercialCategory?: string;
  arrivalPlatform?: string;
  departurePlatform?: string;
}

export interface RouteDto {
  scheduleId: number;
  orderId: number;
  trainOrderId: number;
  name: string | null;
  carrierCode: string | null;
  nationalNumber: string | null;
  commercialCategorySymbol: string | null;
  operatingDates: string[];
  stations: ScheduleStationDto[];
}

export interface SchedulesResponse {
  generatedAt: string;
  period: { from: string; to: string };
  routes: RouteDto[];
  dictionaries?: {
    stations?: Record<string, { name: string } | string>;
    carriers?: Record<string, string>;
    commercialCategories?: Record<string, string>;
  };
}

export interface DisruptionDto {
  disruptionId: number;
  disruptionTypeCode: string;
  startStation: string;
  endStation: string;
  message: string;
}

export interface DisruptionsResponse {
  success: boolean;
  data: {
    disruptions: DisruptionDto[];
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function pkpFetch<T>(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
): Promise<T | null> {
  const url = new URL(path, PKP_API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    console.error(`PKP API error: ${res.status} ${res.statusText} for ${url.pathname}`);
    return null;
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch operations page by page, calling the handler for each page.
 * This avoids holding all 33K trains in memory at once.
 * pageSize=500 keeps each page manageable (~500 trains × ~10 stations = ~5K objects).
 */
export async function fetchOperationsPages(
  apiKey: string,
  onPage: (trains: TrainOperationDto[], stations: Record<string, string>, pageNum: number) => Promise<void>,
): Promise<{ totalTrains: number; stations: Record<string, string> }> {
  let allStations: Record<string, string> = {};
  let page = 1;
  let totalTrains = 0;
  const pageSize = 2000;

  while (true) {
    const res = await pkpFetch<OperationsResponse>(
      "/api/v1/operations",
      apiKey,
      {
        fullRoutes: "true",
        withPlanned: "true",
        page: String(page),
        pageSize: String(pageSize),
      },
    );

    if (!res || !res.trains?.length) {
      if (page === 1) {
        console.warn("[fetchOperationsPages] No data from API on first page");
      }
      break;
    }

    allStations = { ...allStations, ...res.stations };
    totalTrains += res.trains.length;

    await onPage(res.trains, allStations, page);

    if (!res.pagination.hasNextPage) break;
    page++;

    if (page > 100) {
      console.warn(`[fetchOperationsPages] Stopped at page ${page} (safety cap)`);
      break;
    }
  }

  console.log(`[fetchOperationsPages] Processed ${totalTrains} trains across ${page} pages`);
  return { totalTrains, stations: allStations };
}

export async function fetchStatistics(
  apiKey: string,
  date: string,
): Promise<StatisticsResponse | null> {
  return pkpFetch<StatisticsResponse>(
    "/api/v1/operations/statistics",
    apiKey,
    { date },
  );
}

/**
 * Fetch schedules page by page, calling the handler for each page.
 * Accumulates station + carrier dictionaries across pages and passes them to each callback.
 */
export async function fetchSchedulesPages(
  apiKey: string,
  date: string,
  onPage: (routes: RouteDto[], stations: Record<string, string>, pageNum: number) => Promise<void>,
): Promise<{ totalRoutes: number; stations: Record<string, string>; carriers: Record<string, string> }> {
  let allStations: Record<string, string> = {};
  let allCarriers: Record<string, string> = {};
  let page = 1;
  let totalRoutes = 0;
  const pageSize = 1000;

  while (true) {
    const res = await pkpFetch<SchedulesResponse>(
      "/api/v1/schedules",
      apiKey,
      {
        dateFrom: date,
        dateTo: date,
        dictionaries: "true",
        page: String(page),
        pageSize: String(pageSize),
      },
    );

    if (!res || !res.routes?.length) {
      if (page === 1) {
        console.warn("[fetchSchedulesPages] No data from API on first page");
      }
      break;
    }

    if (res.dictionaries?.stations) {
      for (const [id, info] of Object.entries(res.dictionaries.stations)) {
        allStations[id] = typeof info === 'string' ? info : info.name;
      }
    }
    if (res.dictionaries?.carriers) {
      allCarriers = { ...allCarriers, ...res.dictionaries.carriers };
    }

    totalRoutes += res.routes.length;
    await onPage(res.routes, allStations, page);

    if (res.routes.length < pageSize) break;
    page++;

    if (page > 100) {
      console.warn(`[fetchSchedulesPages] Stopped at page ${page} (safety cap)`);
      break;
    }
  }

  console.log(`[fetchSchedulesPages] Processed ${totalRoutes} routes across ${page} pages`);
  return { totalRoutes, stations: allStations, carriers: allCarriers };
}

export async function fetchDisruptions(
  apiKey: string,
): Promise<DisruptionDto[]> {
  const res = await pkpFetch<DisruptionsResponse>(
    "/api/v1/disruptions",
    apiKey,
  );

  if (!res || !res.success || !res.data?.disruptions) {
    console.warn("[fetchDisruptions] No data from API");
    return [];
  }

  return res.data.disruptions;
}
