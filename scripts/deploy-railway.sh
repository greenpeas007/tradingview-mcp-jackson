#!/bin/bash
# Deploy Momentum Rider Bot to Railway
#
# Prerequisites:
#   1. Railway CLI installed: npm i -g @railway/cli
#   2. Login: railway login
#   3. Run this script from project root
#
# This script will:
#   - Create a new Railway project (or link existing)
#   - Set environment variables
#   - Deploy the bot
#   - Generate a public URL for webhooks

set -e

echo "=== Momentum Rider Bot - Railway Deployment ==="
echo ""

# Check if linked to a project
if ! railway status 2>/dev/null; then
    echo "No project linked. Creating new project..."
    railway init -n "momentum-rider-bot"
    echo "Project created!"
fi

echo ""
echo "Setting environment variables..."

# Read from .env and set on Railway
while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    # Skip Railway-specific vars
    [[ "$key" =~ ^RAILWAY_ ]] && continue
    # Trim whitespace
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    [ -z "$key" ] && continue

    echo "  Setting $key"
    railway vars set "$key=$value" 2>/dev/null || true
done < .env

echo ""
echo "Deploying..."
railway up --detach

echo ""
echo "Generating public domain..."
railway domain

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy the railway domain URL above"
echo "  2. Your webhook URL is: https://<domain>/webhook"
echo "  3. Set this URL in TradingView alerts"
echo "  4. Check logs: railway logs"
echo "  5. Check status: curl https://<domain>/status"
