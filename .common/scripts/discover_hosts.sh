#!/bin/bash
set -euo pipefail
IFS=$'\\n\\t'
 

# Discover deployment hosts based on environment
# Usage: discover_hosts.sh <environment>

ENVIRONMENT="$1"

if [ -z "$ENVIRONMENT" ]; then
  echo "::error:: Environment parameter is required"
  exit 1
fi

HOSTS_LIST=()
BASE_FILE=".deployment/env/.env.${ENVIRONMENT}"

# Check if main env file exists
if [ -f "$BASE_FILE" ]; then
  HOSTS_LIST+=("main")
fi

# Check for host-specific env files
for env_file in .deployment/env/.env."${ENVIRONMENT}".*; do
  if [ -f "$env_file" ]; then
    SUFFIX=$(basename "$env_file" | sed "s/\.env\.${ENVIRONMENT}\.//")
    if [[ "$SUFFIX" != "${ENVIRONMENT}" ]]; then
      HOSTS_LIST+=("$SUFFIX")
    fi
  fi
done

# If no env files found, deploy to main host using CI secrets only
if [ ${#HOSTS_LIST[@]} -eq 0 ]; then
  echo "No .env files found for environment ${ENVIRONMENT}, will use CI secrets only" >&2
  HOSTS_LIST+=("main")
fi

# Output JSON array
printf '%s\n' "${HOSTS_LIST[@]}" | jq -R . | jq -s -c .
