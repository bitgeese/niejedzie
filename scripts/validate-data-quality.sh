#!/bin/bash

# Data Quality Validation Script for niejedzie.pl
# Run this before deployments to ensure data integrity

set -e

BASE_URL=${1:-"https://niejedzie.pl"}
QUALITY_THRESHOLD=${2:-95.0}

echo "🔍 Running data quality validation for $BASE_URL"
echo "📊 Quality threshold: ${QUALITY_THRESHOLD}%"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    local status=$1
    local message=$2

    case $status in
        "error")
            echo -e "${RED}❌ $message${NC}"
            ;;
        "success")
            echo -e "${GREEN}✅ $message${NC}"
            ;;
        "warning")
            echo -e "${YELLOW}⚠️  $message${NC}"
            ;;
        *)
            echo "$message"
            ;;
    esac
}

# Check if jq is available
if ! command -v jq &> /dev/null; then
    print_status "error" "jq is required but not installed. Please install jq."
    exit 1
fi

# Check if bc is available for floating point comparison
if ! command -v bc &> /dev/null; then
    print_status "error" "bc is required but not installed. Please install bc."
    exit 1
fi

# 1. Check API availability
echo ""
echo "🌐 Checking API availability..."
if ! curl -s -f "$BASE_URL/api/quality" > /dev/null; then
    print_status "error" "API is not available at $BASE_URL"
    exit 1
fi
print_status "success" "API is accessible"

# 2. Check data freshness
echo ""
echo "⏰ Checking data freshness..."
QUALITY_RESPONSE=$(curl -s "$BASE_URL/api/quality")
LAST_UPDATE=$(echo "$QUALITY_RESPONSE" | jq -r '.lastCheck // empty')

if [ -z "$LAST_UPDATE" ]; then
    print_status "error" "Cannot determine last update time"
    exit 1
fi

# Calculate age in minutes
LAST_UPDATE_UNIX=$(date -d "$LAST_UPDATE" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_UPDATE%.*}" +%s)
CURRENT_UNIX=$(date +%s)
AGE_MINUTES=$(( (CURRENT_UNIX - LAST_UPDATE_UNIX) / 60 ))

if [ $AGE_MINUTES -gt 10 ]; then
    print_status "error" "Data is stale (${AGE_MINUTES} minutes old)"
    exit 1
elif [ $AGE_MINUTES -gt 5 ]; then
    print_status "warning" "Data is ${AGE_MINUTES} minutes old (acceptable but not fresh)"
else
    print_status "success" "Data is fresh (${AGE_MINUTES} minutes old)"
fi

# 3. Check for critical issues
echo ""
echo "🚨 Checking for critical issues..."
CRITICAL_COUNT=$(echo "$QUALITY_RESPONSE" | jq '[.issues[]? | select(.severity == "critical")] | length')
ERROR_COUNT=$(echo "$QUALITY_RESPONSE" | jq '[.issues[]? | select(.severity == "error")] | length')
WARNING_COUNT=$(echo "$QUALITY_RESPONSE" | jq '[.issues[]? | select(.severity == "warning")] | length')

if [ "$CRITICAL_COUNT" -gt 0 ]; then
    print_status "error" "${CRITICAL_COUNT} critical issues found"
    echo "$QUALITY_RESPONSE" | jq '.issues[] | select(.severity == "critical")'
    exit 1
fi

if [ "$ERROR_COUNT" -gt 5 ]; then
    print_status "error" "${ERROR_COUNT} error-level issues found (threshold: 5)"
    exit 1
elif [ "$ERROR_COUNT" -gt 0 ]; then
    print_status "warning" "${ERROR_COUNT} error-level issues found (within threshold)"
fi

if [ "$WARNING_COUNT" -gt 0 ]; then
    print_status "warning" "${WARNING_COUNT} warning-level issues found"
fi

if [ "$CRITICAL_COUNT" -eq 0 ] && [ "$ERROR_COUNT" -eq 0 ]; then
    print_status "success" "No critical or error-level issues found"
fi

# 4. Validate sample trains for data consistency
echo ""
echo "🚂 Validating sample trains..."
SAMPLE_TRAINS=("10953" "40368" "34000" "87944")
VALIDATION_ERRORS=0

for train in "${SAMPLE_TRAINS[@]}"; do
    echo "  Checking train $train..."

    TRAIN_RESPONSE=$(curl -s "$BASE_URL/api/train/search?q=$train")
    STATION_COUNT=$(echo "$TRAIN_RESPONSE" | jq '.stations | length')

    if [ "$STATION_COUNT" -eq 0 ]; then
        print_status "warning" "  Train $train has no stations"
        continue
    fi

    # Check for sudden delay jumps (>30 minutes between adjacent stations)
    DELAY_JUMPS=$(echo "$TRAIN_RESPONSE" | jq '
        [.stations[] | select(.delay != null) | .delay] as $delays |
        [range(1; $delays | length) |
         if $delays[.] != null and $delays[.-1] != null
         then ($delays[.] - $delays[.-1])
         else 0 end
        ] |
        map(if . > 30 or . < -30 then . else empty end) |
        length
    ')

    if [ "$DELAY_JUMPS" -gt 0 ]; then
        print_status "error" "  Train $train has ${DELAY_JUMPS} sudden delay jumps >30min"
        VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))

        # Show the actual delay progression for debugging
        echo "    Delay progression:"
        echo "$TRAIN_RESPONSE" | jq -r '.stations[] | select(.delay != null) | "      \(.name): \(.delay)min"' | head -10
        if [ "$STATION_COUNT" -gt 10 ]; then
            echo "      ... and $((STATION_COUNT - 10)) more stations"
        fi
    fi

    # Check for suspicious 00:00 times (actualArr = "00:00" when planned is not)
    SUSPICIOUS_TIMES=$(echo "$TRAIN_RESPONSE" | jq '
        [.stations[] |
         select(.actualArr == "00:00" and .plannedArr != null and .plannedArr != "00:00")
        ] | length
    ')

    if [ "$SUSPICIOUS_TIMES" -gt 0 ]; then
        print_status "warning" "  Train $train has ${SUSPICIOUS_TIMES} suspicious 00:00 times"
        echo "$TRAIN_RESPONSE" | jq -r '.stations[] | select(.actualArr == "00:00" and .plannedArr != null and .plannedArr != "00:00") | "      \(.name): planned \(.plannedArr), actual 00:00"'
    fi

    # Check station count is reasonable (should have >1 station for most trains)
    if [ "$STATION_COUNT" -eq 1 ]; then
        print_status "warning" "  Train $train has only 1 station (possible parsing issue)"
    else
        print_status "success" "  Train $train has ${STATION_COUNT} stations"
    fi
done

if [ $VALIDATION_ERRORS -gt 0 ]; then
    print_status "error" "Found ${VALIDATION_ERRORS} validation errors in sample trains"
    exit 1
fi

# 5. Check API response times
echo ""
echo "⚡ Checking API response times..."
RESPONSE_TIME=$(curl -o /dev/null -s -w "%{time_total}" "$BASE_URL/api/delays/today")
RESPONSE_MS=$(echo "$RESPONSE_TIME * 1000" | bc | cut -d. -f1)

if [ "$RESPONSE_MS" -gt 5000 ]; then
    print_status "error" "API response time too slow: ${RESPONSE_MS}ms (threshold: 5000ms)"
    exit 1
elif [ "$RESPONSE_MS" -gt 2000 ]; then
    print_status "warning" "API response time: ${RESPONSE_MS}ms (acceptable but slow)"
else
    print_status "success" "API response time: ${RESPONSE_MS}ms"
fi

# 6. Final summary
echo ""
echo "📋 Data Quality Summary:"
echo "  ✓ API Availability: OK"
echo "  ✓ Data Freshness: ${AGE_MINUTES} minutes"
echo "  ✓ Critical Issues: ${CRITICAL_COUNT}"
echo "  ✓ Error Issues: ${ERROR_COUNT}"
echo "  ✓ Warning Issues: ${WARNING_COUNT}"
echo "  ✓ Sample Trains: Validated ${#SAMPLE_TRAINS[@]} trains"
echo "  ✓ API Response Time: ${RESPONSE_MS}ms"

print_status "success" "All data quality checks passed! 🎉"
exit 0