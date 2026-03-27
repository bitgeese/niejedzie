/**
 * Auto-healing data validation and correction system
 * Automatically fixes common data quality issues
 */

interface HealingResult {
  stationName: string;
  originalIssues: string[];
  appliedFixes: string[];
  confidence: 'high' | 'medium' | 'low' | 'estimated';
  healingReason: string;
}

interface TrainContext {
  trainNumber: string;
  previousStations: Array<{
    stationName: string;
    delay: number | null;
    actualTime: string | null;
  }>;
  averageDelay: number;
  delayTrend: 'increasing' | 'decreasing' | 'stable';
}

/**
 * Auto-heal station data using intelligent algorithms
 */
export async function autoHealStationData(
  station: any,
  context: TrainContext
): Promise<{ healedStation: any; healingResult: HealingResult }> {

  const originalStation = { ...station };
  const healedStation = { ...station };
  const appliedFixes: string[] = [];
  const originalIssues: string[] = [];

  // 1. Fix suspicious 00:00:00 timestamps with intelligent estimation
  if (station.actualArrival?.includes('T00:00:00') &&
      station.plannedArrival && !station.plannedArrival.includes('T00:00:00')) {

    originalIssues.push('suspicious_midnight_time');

    const estimatedTime = estimateActualTime(station, context);
    if (estimatedTime) {
      healedStation.actualArrival = estimatedTime.isoString;
      healedStation.arrivalDelayMinutes = estimatedTime.delayMinutes;
      appliedFixes.push('estimated_actual_time_from_delay_pattern');

      console.log(`[auto-heal] ${station.stationName}: Fixed 00:00 → ${estimatedTime.isoString} (${estimatedTime.delayMinutes}min delay)`);
    } else {
      // If estimation fails, set to null rather than keep bad data
      healedStation.actualArrival = null;
      healedStation.arrivalDelayMinutes = null;
      appliedFixes.push('removed_suspicious_timestamp');
    }
  }

  // 2. Fix extreme delay outliers using statistical correction
  if (station.arrivalDelayMinutes && Math.abs(station.arrivalDelayMinutes) > 120) {
    originalIssues.push('extreme_delay');

    const correctedDelay = correctExtremeDelay(station, context);
    if (correctedDelay !== null && Math.abs(correctedDelay - station.arrivalDelayMinutes) > 30) {
      healedStation.arrivalDelayMinutes = correctedDelay;

      // Recalculate actual time based on corrected delay
      if (station.plannedArrival) {
        const plannedTime = new Date(station.plannedArrival);
        const correctedActualTime = new Date(plannedTime.getTime() + (correctedDelay * 60 * 1000));
        healedStation.actualArrival = correctedActualTime.toISOString();
      }

      appliedFixes.push('corrected_extreme_delay_using_interpolation');
      console.log(`[auto-heal] ${station.stationName}: Corrected extreme delay ${station.arrivalDelayMinutes}min → ${correctedDelay}min`);
    }
  }

  // 3. Fix missing actual times using pattern prediction
  if (!station.actualArrival && station.plannedArrival && context.previousStations.length > 1) {
    originalIssues.push('missing_actual_time');

    const predictedTime = predictMissingActualTime(station, context);
    if (predictedTime) {
      healedStation.actualArrival = predictedTime.isoString;
      healedStation.arrivalDelayMinutes = predictedTime.delayMinutes;
      appliedFixes.push('predicted_missing_actual_time');

      console.log(`[auto-heal] ${station.stationName}: Predicted missing time → ${predictedTime.isoString}`);
    }
  }

  // 4. Fix inconsistent delay progressions
  if (context.previousStations.length > 0 && station.arrivalDelayMinutes !== null) {
    const lastDelay = context.previousStations[context.previousStations.length - 1].delay;
    if (lastDelay !== null) {
      const delayJump = Math.abs(station.arrivalDelayMinutes - lastDelay);

      if (delayJump > 45) { // Sudden jump >45 minutes
        originalIssues.push('sudden_delay_jump');

        const smoothedDelay = smoothDelayProgression(station, context);
        if (smoothedDelay !== station.arrivalDelayMinutes) {
          healedStation.arrivalDelayMinutes = smoothedDelay;

          // Recalculate actual time
          if (station.plannedArrival) {
            const plannedTime = new Date(station.plannedArrival);
            const smoothedActualTime = new Date(plannedTime.getTime() + (smoothedDelay * 60 * 1000));
            healedStation.actualArrival = smoothedActualTime.toISOString();
          }

          appliedFixes.push('smoothed_delay_progression');
          console.log(`[auto-heal] ${station.stationName}: Smoothed delay jump ${station.arrivalDelayMinutes}min → ${smoothedDelay}min`);
        }
      }
    }
  }

  // Determine confidence level based on applied fixes
  let confidence: 'high' | 'medium' | 'low' | 'estimated' = 'high';
  if (appliedFixes.length > 0) {
    if (appliedFixes.some(fix => fix.includes('estimated') || fix.includes('predicted'))) {
      confidence = 'estimated';
    } else if (appliedFixes.length >= 2) {
      confidence = 'low';
    } else {
      confidence = 'medium';
    }
  }

  const healingResult: HealingResult = {
    stationName: station.stationName,
    originalIssues,
    appliedFixes,
    confidence,
    healingReason: appliedFixes.join(', ') || 'no_issues_detected'
  };

  return { healedStation, healingResult };
}

/**
 * Estimate actual arrival time using delay patterns from previous stations
 */
function estimateActualTime(station: any, context: TrainContext): { isoString: string; delayMinutes: number } | null {
  if (!station.plannedArrival || context.previousStations.length < 2) {
    return null;
  }

  // Get recent delays (exclude outliers)
  const recentDelays = context.previousStations
    .slice(-3) // Last 3 stations
    .map(s => s.delay)
    .filter(d => d !== null && Math.abs(d) < 120); // Exclude extreme delays

  if (recentDelays.length === 0) {
    return null;
  }

  // Calculate trend-aware delay estimation
  let estimatedDelay: number;

  if (context.delayTrend === 'increasing') {
    // If delays are increasing, use the higher end of recent delays
    estimatedDelay = Math.max(...recentDelays);
  } else if (context.delayTrend === 'decreasing') {
    // If delays are decreasing, use the lower end
    estimatedDelay = Math.min(...recentDelays);
  } else {
    // Stable trend, use average
    estimatedDelay = recentDelays.reduce((a, b) => a + b, 0) / recentDelays.length;
  }

  // Add some uncertainty bounds (±2 minutes)
  estimatedDelay = Math.round(estimatedDelay);

  const plannedTime = new Date(station.plannedArrival);
  const estimatedActualTime = new Date(plannedTime.getTime() + (estimatedDelay * 60 * 1000));

  return {
    isoString: estimatedActualTime.toISOString(),
    delayMinutes: estimatedDelay
  };
}

/**
 * Correct extreme delays using statistical interpolation
 */
function correctExtremeDelay(station: any, context: TrainContext): number | null {
  if (context.previousStations.length < 2) {
    return null;
  }

  const recentDelays = context.previousStations
    .slice(-3)
    .map(s => s.delay)
    .filter(d => d !== null && Math.abs(d) < 120);

  if (recentDelays.length < 2) {
    return null;
  }

  // Use median of recent delays as a more robust estimate
  const sortedDelays = recentDelays.sort((a, b) => a - b);
  const median = sortedDelays[Math.floor(sortedDelays.length / 2)];

  // Allow for some natural progression but cap extreme values
  const maxReasonableChange = 15; // Maximum 15-minute change from median
  const lastDelay = context.previousStations[context.previousStations.length - 1].delay || median;

  return Math.max(
    median - maxReasonableChange,
    Math.min(median + maxReasonableChange, lastDelay + maxReasonableChange)
  );
}

/**
 * Predict missing actual time using route patterns
 */
function predictMissingActualTime(station: any, context: TrainContext): { isoString: string; delayMinutes: number } | null {
  return estimateActualTime(station, context); // Use same logic as estimation
}

/**
 * Smooth sudden delay progression jumps
 */
function smoothDelayProgression(station: any, context: TrainContext): number {
  if (context.previousStations.length === 0) {
    return station.arrivalDelayMinutes;
  }

  const lastDelay = context.previousStations[context.previousStations.length - 1].delay || 0;
  const currentDelay = station.arrivalDelayMinutes;

  // Limit sudden changes to 20 minutes maximum
  const maxChange = 20;

  if (currentDelay > lastDelay + maxChange) {
    return lastDelay + maxChange;
  } else if (currentDelay < lastDelay - maxChange) {
    return lastDelay - maxChange;
  }

  return currentDelay;
}

/**
 * Calculate delay trend from previous stations
 */
export function calculateDelayTrend(previousStations: Array<{ delay: number | null }>): 'increasing' | 'decreasing' | 'stable' {
  if (previousStations.length < 3) {
    return 'stable';
  }

  const recentDelays = previousStations
    .slice(-3)
    .map(s => s.delay)
    .filter(d => d !== null);

  if (recentDelays.length < 3) {
    return 'stable';
  }

  const firstDelay = recentDelays[0];
  const lastDelay = recentDelays[recentDelays.length - 1];
  const difference = lastDelay - firstDelay;

  if (difference > 5) {
    return 'increasing';
  } else if (difference < -5) {
    return 'decreasing';
  } else {
    return 'stable';
  }
}

/**
 * Apply auto-healing to a complete train's station data
 */
export async function autoHealTrainData(trainData: any): Promise<{
  healedTrain: any;
  healingReport: HealingResult[];
}> {
  const healingReport: HealingResult[] = [];
  const healedStations = [];

  for (let i = 0; i < trainData.stations.length; i++) {
    const station = trainData.stations[i];

    // Build context from previous stations
    const context: TrainContext = {
      trainNumber: trainData.trainNumber,
      previousStations: healedStations.map(s => ({
        stationName: s.stationName,
        delay: s.arrivalDelayMinutes,
        actualTime: s.actualArrival
      })),
      averageDelay: healedStations.length > 0
        ? healedStations.reduce((sum, s) => sum + (s.arrivalDelayMinutes || 0), 0) / healedStations.length
        : 0,
      delayTrend: calculateDelayTrend(healedStations)
    };

    const { healedStation, healingResult } = await autoHealStationData(station, context);

    healedStations.push(healedStation);
    if (healingResult.appliedFixes.length > 0) {
      healingReport.push(healingResult);
    }
  }

  return {
    healedTrain: { ...trainData, stations: healedStations },
    healingReport
  };
}