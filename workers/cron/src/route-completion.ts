/**
 * Route Completion Module
 * Detects and fixes incomplete train routes where destination stations are missing
 */

interface RouteCompletionResult {
  wasIncomplete: boolean;
  addedStations: string[];
  completionMethod: 'estimated' | 'historical' | 'fallback';
  confidence: number;
}

/**
 * Detect if a train route is incomplete (missing destination or intermediate stations)
 */
export function detectIncompleteRoute(trainData: any): boolean {
  const { train, stations } = trainData;

  if (!train.routeEnd || !stations || stations.length === 0) {
    return false;
  }

  // Check if destination station exists in the station list
  const hasDestination = stations.some((station: any) =>
    station.stationName?.includes(train.routeEnd) ||
    station.stationName === train.routeEnd
  );

  if (!hasDestination) {
    console.warn(`[route-completion] Missing destination: ${train.routeEnd} not found in stations`);
    return true;
  }

  // Check if route seems suspiciously short (< 5 stations for long-distance trains)
  if (stations.length < 5 && isLongDistanceRoute(train.routeStart, train.routeEnd)) {
    console.warn(`[route-completion] Suspiciously short route: ${stations.length} stations for ${train.routeStart} → ${train.routeEnd}`);
    return true;
  }

  return false;
}

/**
 * Complete an incomplete route by adding missing destination station
 */
export async function completeIncompleteRoute(
  trainData: any,
  env?: any
): Promise<{ completedTrain: any; completionResult: RouteCompletionResult }> {

  const completionResult: RouteCompletionResult = {
    wasIncomplete: false,
    addedStations: [],
    completionMethod: 'fallback',
    confidence: 0
  };

  if (!detectIncompleteRoute(trainData)) {
    return { completedTrain: trainData, completionResult };
  }

  completionResult.wasIncomplete = true;
  const completedStations = [...trainData.stations];

  // Add missing destination station if not present
  if (!trainData.stations.some((s: any) => s.stationName === trainData.train.routeEnd)) {
    const destinationStation = createEstimatedDestinationStation(trainData);
    completedStations.push(destinationStation);
    completionResult.addedStations.push(trainData.train.routeEnd);
    completionResult.completionMethod = 'estimated';
    completionResult.confidence = 0.7;

    console.log(`[route-completion] Added missing destination: ${trainData.train.routeEnd}`);
  }

  // Try to add likely intermediate stations for known routes
  const intermediateStations = await addLikelyIntermediateStations(trainData, env);
  if (intermediateStations.length > 0) {
    completedStations.push(...intermediateStations);
    completionResult.addedStations.push(...intermediateStations.map((s: any) => s.stationName));
    completionResult.confidence = Math.min(completionResult.confidence + 0.2, 0.9);
  }

  const completedTrain = {
    ...trainData,
    stations: completedStations.sort((a: any, b: any) => a.sequenceNumber - b.sequenceNumber)
  };

  return { completedTrain, completionResult };
}

/**
 * Create an estimated destination station based on route information
 */
function createEstimatedDestinationStation(trainData: any): any {
  const lastStation = trainData.stations[trainData.stations.length - 1];
  const train = trainData.train;

  // Estimate timing based on last known station
  let estimatedArrival: string | null = null;
  let estimatedDelay: number | null = null;

  if (lastStation?.plannedArrival && lastStation?.delay !== null) {
    // Estimate 30 minutes travel time from last station to destination
    const lastPlannedTime = new Date(lastStation.plannedArrival);
    const estimatedPlannedTime = new Date(lastPlannedTime.getTime() + (30 * 60 * 1000));

    estimatedArrival = estimatedPlannedTime.toISOString();
    estimatedDelay = lastStation.delay; // Assume similar delay
  }

  return {
    stationId: hashCode(train.routeEnd),
    stationName: train.routeEnd,
    sequenceNumber: trainData.stations.length + 1,
    plannedArrival: estimatedArrival,
    plannedDeparture: null,
    actualArrival: null,
    actualDeparture: null,
    arrivalDelayMinutes: estimatedDelay,
    departureDelayMinutes: null,
    isConfirmed: false,
    isCancelled: false,
    // Mark as estimated for user transparency
    confidence: 'estimated',
    dataSource: 'route_completion',
    estimationReason: 'missing_destination_added'
  };
}

/**
 * Add likely intermediate stations for known routes
 */
async function addLikelyIntermediateStations(trainData: any, env?: any): Promise<any[]> {
  // For now, return empty array - this could be enhanced with historical route data
  // In the future, we could query a database of known routes or use GTFS data
  return [];
}

/**
 * Check if this appears to be a long-distance route
 */
function isLongDistanceRoute(routeStart: string, routeEnd: string): boolean {
  if (!routeStart || !routeEnd) return false;

  // Known long-distance route patterns
  const longDistancePatterns = [
    ['Częstochowa', 'Katowice'],
    ['Warszawa', 'Kraków'],
    ['Gdańsk', 'Warszawa'],
    ['Poznań', 'Wrocław'],
    ['Szczecin', 'Warszawa']
  ];

  return longDistancePatterns.some(([start, end]) =>
    (routeStart.includes(start) && routeEnd.includes(end)) ||
    (routeStart.includes(end) && routeEnd.includes(start))
  );
}

/**
 * Generate a simple hash code for station ID
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}