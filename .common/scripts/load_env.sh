#!/bin/bash
# Load environment variables from .env files and override with CI secrets
# Usage: source load_env.sh <environment> <hostname>

ENV="$1"
HOSTNAME="${2:-main}"
SYSTEM_USER="$USER"

# Convert Windows line endings to Unix line endings in .deployment files
if [ -d ".deployment" ]; then
  find .deployment -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true
fi

# Load secrets from secrets.json
if [ -f "secrets.json" ]; then
  echo "Loading secrets from secrets.json"
  for key in $(jq -r 'keys[]' secrets.json); do
    export "$key=$(jq -r --arg key "$key" '.[$key]' secrets.json)"
  done
fi

# Load environment files
set -a
if [ -f ".deployment/env/.env.${ENV}" ]; then
  echo "Loading .deployment/env/.env.${ENV}"
  source ".deployment/env/.env.${ENV}"
elif [[ "$ENV" == "build" ]] && [ -f ".deployment/env/.env.production" ]; then
  echo "No .deployment/env/.env.${ENV} file found, loading .deployment/env/.env.production instead"
  source ".deployment/env/.env.production"
else
  echo "No .deployment/env/.env.${ENV} file found, using CI secrets only"
fi

# Load host-specific file
if [[ "$HOSTNAME" != "main" && -f ".deployment/env/.env.${ENV}.${HOSTNAME}" ]]; then
  echo "Loading .deployment/env/.env.${ENV}.${HOSTNAME}"
  source ".deployment/env/.env.${ENV}.${HOSTNAME}"
fi
set +a

ENV_PREFIX="$(echo "${ENV}" | tr '[:lower:]' '[:upper:]')_"

# Parse CONNECTION string if provided (format: base64 encoded JSON with host, port, user, privateKey, password)
CONNECTION_VAR_NAME="${ENV_PREFIX}CONNECTION"
if [[ -n "${!CONNECTION_VAR_NAME}" ]]; then
  echo "Parsing ${CONNECTION_VAR_NAME}..."
  CONNECTION_JSON=$(echo "${!CONNECTION_VAR_NAME}" | base64 -d 2>/dev/null)
  if [[ $? -eq 0 && -n "$CONNECTION_JSON" ]]; then
    export DOCKFLOW_HOST=$(echo "$CONNECTION_JSON" | jq -r '.host // empty')
    export DOCKFLOW_PORT=$(echo "$CONNECTION_JSON" | jq -r '.port // empty')
    export DOCKFLOW_USER=$(echo "$CONNECTION_JSON" | jq -r '.user // empty')
    export SSH_PRIVATE_KEY=$(echo "$CONNECTION_JSON" | jq -r '.privateKey // empty')
    export DOCKFLOW_PASSWORD=$(echo "$CONNECTION_JSON" | jq -r '.password // empty')
    unset "${CONNECTION_VAR_NAME}"
    echo "✓ Connection details loaded from ${CONNECTION_VAR_NAME}"
  else
    echo "::warning:: Failed to decode ${CONNECTION_VAR_NAME}, skipping..."
  fi
fi

# Override from CI secrets
if [[ "$HOSTNAME" == "main" ]]; then
  while IFS= read -r var; do
    [[ "$var" =~ ^${ENV_PREFIX}.+ ]] && export "${var#${ENV_PREFIX}}=${!var}"
  done < <(env | awk -F= -v prefix="$ENV_PREFIX" '$1 ~ "^"prefix {print $1}')
else
  ENV_HOSTNAME_PREFIX="${ENV_PREFIX}$(echo "${HOSTNAME}" | tr '[:lower:]' '[:upper:]')_"
  while IFS= read -r var; do
    [[ "$var" =~ ^${ENV_HOSTNAME_PREFIX}.+ ]] && export "${var#${ENV_HOSTNAME_PREFIX}}=${!var}"
  done < <(env | awk -F= -v prefix="$ENV_HOSTNAME_PREFIX" '$1 ~ "^"prefix {print $1}')
fi

# Set DOCKFLOW_USER (override if CI, default to 'dockflow')
[[ -n "$DOCKFLOW_USER" && "$DOCKFLOW_USER" != "$SYSTEM_USER" ]] && export DOCKFLOW_USER="$DOCKFLOW_USER" || export DOCKFLOW_USER="dockflow"

# Verify required variables (skip for build environment)
if [[ "$ENV" != "build" ]]; then
  [[ -z "$DOCKFLOW_HOST" ]] && echo "::error:: DOCKFLOW_HOST is not defined. Please set it in .env file or as CI secret (${ENV_PREFIX}DOCKFLOW_HOST)" && exit 1
  [[ -z "$SSH_PRIVATE_KEY" ]] && echo "::error:: SSH_PRIVATE_KEY is not defined. Please set it as CI secret (${ENV_PREFIX}SSH_PRIVATE_KEY)" && exit 1
fi

# Export to YAML
echo "Exporting environment variables to /tmp/ansible_env_vars.yml..."
python3 << 'PYTHON_EOF'
import os, yaml
env_vars = {k.lower(): v for k, v in os.environ.items() if k and k not in ['_', 'OLDPWD']}
with open('/tmp/ansible_env_vars.yml', 'w') as f:
    yaml.dump(env_vars, f, default_flow_style=False, allow_unicode=True)
PYTHON_EOF
echo "✓ Environment variables exported to /tmp/ansible_env_vars.yml"
