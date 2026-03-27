#!/bin/bash

# Safe Deployment Script with Data Quality Gates
# Usage: ./scripts/deploy.sh [main|cron] [--force] [--skip-validation]

set -e

# Configuration
COMPONENT=${1:-"main"}
FORCE_DEPLOY=${2:-false}
SKIP_VALIDATION=${SKIP_VALIDATION:-false}

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
}

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
        "info")
            echo -e "${BLUE}ℹ️  $message${NC}"
            ;;
    esac
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE_DEPLOY=true
            shift
            ;;
        --skip-validation)
            SKIP_VALIDATION=true
            shift
            ;;
        *)
            if [ -z "$COMPONENT" ]; then
                COMPONENT=$1
            fi
            shift
            ;;
    esac
done

print_header "🚀 niejedzie.pl Deployment"
echo "Component: $COMPONENT"
echo "Force deploy: $FORCE_DEPLOY"
echo "Skip validation: $SKIP_VALIDATION"
echo ""

# Validate component argument
case $COMPONENT in
    "main"|"site"|"frontend")
        COMPONENT="main"
        ;;
    "cron"|"worker"|"backend")
        COMPONENT="cron"
        ;;
    *)
        print_status "error" "Invalid component: $COMPONENT"
        echo "Valid components: main, cron"
        exit 1
        ;;
esac

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
    print_status "error" "Must run from the niejedzie project root"
    exit 1
fi

# 1. Pre-deployment Quality Gate
print_header "🛡️  Pre-deployment Quality Gate"

if [ "$SKIP_VALIDATION" = "false" ]; then
    if ! ./scripts/pre-deploy-check.sh; then
        if [ "$FORCE_DEPLOY" = "true" ]; then
            print_status "warning" "Quality gate failed but proceeding due to --force flag"
        else
            print_status "error" "Quality gate failed. Use --force to override (not recommended)"
            exit 1
        fi
    fi
else
    print_status "warning" "Skipping quality validation"
fi

# 2. Build Process
print_header "🏗️  Building Application"

if [ "$COMPONENT" = "main" ]; then
    print_status "info" "Building main site..."

    # Clean previous builds
    rm -rf dist .wrangler

    # Build
    if ! npm run build; then
        print_status "error" "Build failed"
        exit 1
    fi

    print_status "success" "Main site built successfully"

elif [ "$COMPONENT" = "cron" ]; then
    print_status "info" "Building cron worker..."

    # Cron worker doesn't need build step, just verify the files exist
    if [ ! -f "workers/cron/src/index.ts" ]; then
        print_status "error" "Cron worker source not found"
        exit 1
    fi

    print_status "success" "Cron worker ready for deployment"
fi

# 3. Deployment
print_header "🚀 Deploying to Production"

if [ "$COMPONENT" = "main" ]; then
    print_status "info" "Deploying main site to Cloudflare Workers..."

    cd dist/server
    if npx wrangler deploy; then
        print_status "success" "Main site deployed successfully"
        DEPLOYMENT_URL="https://niejedzie.maciej-janowski1.workers.dev"
    else
        print_status "error" "Main site deployment failed"
        exit 1
    fi
    cd ../..

elif [ "$COMPONENT" = "cron" ]; then
    print_status "info" "Deploying cron worker to Cloudflare..."

    cd workers/cron
    if npx wrangler deploy; then
        print_status "success" "Cron worker deployed successfully"
        DEPLOYMENT_URL="https://niejedzie-cron.maciej-janowski1.workers.dev"
    else
        print_status "error" "Cron worker deployment failed"
        exit 1
    fi
    cd ../..
fi

# 4. Post-deployment Validation
print_header "🔍 Post-deployment Validation"

print_status "info" "Waiting 30 seconds for deployment to propagate..."
sleep 30

# Test the deployment
if [ "$COMPONENT" = "main" ]; then
    TEST_URL="https://niejedzie.pl"

    print_status "info" "Testing main site..."

    # Basic availability check
    if curl -s -f "$TEST_URL" > /dev/null; then
        print_status "success" "Main site is accessible"
    else
        print_status "error" "Main site is not accessible"
        exit 1
    fi

    # API health check
    if curl -s -f "$TEST_URL/api/quality" > /dev/null; then
        print_status "success" "API is responding"
    else
        print_status "error" "API is not responding"
        exit 1
    fi

    # Run post-deployment data quality check (less strict)
    if [ "$SKIP_VALIDATION" = "false" ]; then
        print_status "info" "Running post-deployment data quality check..."
        if ./scripts/validate-data-quality.sh "$TEST_URL"; then
            print_status "success" "Post-deployment validation passed"
        else
            print_status "warning" "Post-deployment validation failed (deployment still active)"
        fi
    fi
fi

# 5. Success Summary
print_header "🎉 Deployment Complete"

print_status "success" "Component: $COMPONENT"
print_status "success" "Status: Successfully deployed"
if [ -n "$DEPLOYMENT_URL" ]; then
    print_status "success" "Worker URL: $DEPLOYMENT_URL"
fi
print_status "success" "Live URL: https://niejedzie.pl"

echo ""
echo "🔗 Useful links:"
echo "   📊 Live site: https://niejedzie.pl"
echo "   🔍 Quality monitoring: https://niejedzie.pl/api/quality"
echo "   📈 Delays dashboard: https://niejedzie.pl/opoznienia/dzisiaj"

if [ "$COMPONENT" = "main" ]; then
    echo "   🚂 Train search: https://niejedzie.pl/gdzie-jest-pociag"
fi

echo ""
echo "✅ Deployment completed successfully!"
exit 0