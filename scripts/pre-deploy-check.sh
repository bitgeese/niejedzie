#!/bin/bash

# Pre-deployment Data Quality Gate
# This script MUST pass before any deployment is allowed

set -e

echo "🚀 Pre-deployment Quality Gate for niejedzie.pl"
echo "================================================"

# Configuration
ENVIRONMENT=${1:-"https://niejedzie.pl"}
SKIP_VALIDATION=${SKIP_VALIDATION:-false}

if [ "$SKIP_VALIDATION" = "true" ]; then
    echo "⚠️  WARNING: Skipping data quality validation (SKIP_VALIDATION=true)"
    echo "✅ Pre-deployment check completed (validation skipped)"
    exit 0
fi

# 1. Check if validation script exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATION_SCRIPT="$SCRIPT_DIR/validate-data-quality.sh"

if [ ! -f "$VALIDATION_SCRIPT" ]; then
    echo "❌ Data quality validation script not found at $VALIDATION_SCRIPT"
    exit 1
fi

# 2. Run data quality validation
echo ""
echo "🔍 Running data quality validation..."
echo "Environment: $ENVIRONMENT"

if ! "$VALIDATION_SCRIPT" "$ENVIRONMENT"; then
    echo ""
    echo "❌ DEPLOYMENT BLOCKED: Data quality validation failed"
    echo ""
    echo "The current data quality does not meet deployment standards."
    echo "Please fix the identified issues before deploying."
    echo ""
    echo "To override this check (NOT RECOMMENDED), set SKIP_VALIDATION=true"
    echo "Example: SKIP_VALIDATION=true ./scripts/pre-deploy-check.sh"
    echo ""
    exit 1
fi

# 3. Additional pre-deployment checks
echo ""
echo "🔧 Running additional pre-deployment checks..."

# Check if recent commits might affect data quality
echo "📝 Checking recent changes..."
if git rev-parse --git-dir > /dev/null 2>&1; then
    RECENT_COMMITS=$(git log --oneline -5 --grep="scraper\|data\|validation\|quality")
    if [ -n "$RECENT_COMMITS" ]; then
        echo "Recent data-related commits found:"
        echo "$RECENT_COMMITS"
        echo ""
    fi
fi

# Check if build artifacts exist
echo "🏗️  Checking build artifacts..."
if [ -d "dist" ]; then
    echo "✅ Build directory found"

    # Check if dist contains expected files
    if [ -d "dist/server" ] && [ -f "dist/server/wrangler.json" ]; then
        echo "✅ Server build artifacts present"
    else
        echo "⚠️  Server build artifacts incomplete"
    fi
else
    echo "⚠️  No dist directory found (may need to run build first)"
fi

# 4. Environment-specific checks
echo ""
echo "🌍 Environment-specific checks..."

if [[ "$ENVIRONMENT" == *"niejedzie.pl"* ]] || [[ "$ENVIRONMENT" == *"production"* ]]; then
    echo "🔴 PRODUCTION deployment detected"
    echo "   Extra validation required for production deployments"

    # More strict validation for production
    if ! "$VALIDATION_SCRIPT" "$ENVIRONMENT" > /tmp/prod_validation.log 2>&1; then
        echo "❌ PRODUCTION DEPLOYMENT BLOCKED"
        echo "Production requires 100% data quality validation"
        cat /tmp/prod_validation.log
        exit 1
    fi

    echo "✅ Production validation passed"
else
    echo "🔵 Development/staging deployment"
fi

# 5. Final summary
echo ""
echo "✅ All pre-deployment checks passed!"
echo ""
echo "🚀 Ready for deployment to $ENVIRONMENT"
echo ""
echo "Deployment checklist:"
echo "  ✓ Data quality validation passed"
echo "  ✓ Build artifacts verified"
echo "  ✓ Environment checks completed"
echo ""

exit 0