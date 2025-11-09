#!/bin/bash
# Load environment variables from .env files and override with CI secrets
# Usage: source load_env.sh <environment> <hostname>

ENV="$1"
HOSTNAME="${2:-main}"

#######################################
######### Load secrets ################
#######################################
# Load secrets as environment variables from secrets.json if it exists
if [ -f "secrets.json" ]; then
  echo "Loading secrets from secrets.json"
  for key in $(jq -r 'keys[]' secrets.json); do
    value=$(jq -r --arg key "$key" '.[$key]' secrets.json)
    export "$key=$value"
  done
fi

#######################################
######### Load env variables ##########
#######################################
set -a

# Load base environment file
if [ -f ".deployment/env/.env.${ENV}" ]; then
  echo "Loading .deployment/env/.env.${ENV}"
  source ".deployment/env/.env.${ENV}"
else
  if [[ "$ENV" == "build" ]] && [ -f ".deployment/env/.env.production" ]; then
    echo "No .deployment/env/.env.${ENV} file found, loading .deployment/env/.env.production instead"
    source ".deployment/env/.env.production"
  else
    echo "No .deployment/env/.env.${ENV} file found, using CI secrets only"
  fi
fi

# Load host-specific file if not main
if [[ "$HOSTNAME" != "main" ]]; then
  if [ -f ".deployment/env/.env.${ENV}.${HOSTNAME}" ]; then
    echo "Loading .deployment/env/.env.${ENV}.${HOSTNAME}"
    source ".deployment/env/.env.${ENV}.${HOSTNAME}"
  fi
fi

set +a

# Override variables from CI secrets if defined
ENV_PREFIX="$(echo "${ENV}" | tr '[:lower:]' '[:upper:]')_"

if [[ "$HOSTNAME" == "main" ]]; then
  # Main host: process ENV_* variables
  while IFS= read -r var; do
    if [[ "$var" =~ ^${ENV_PREFIX}.+ ]]; then
      var_name="${var#${ENV_PREFIX}}"
      var_value="${!var}"
      export "$var_name=$var_value"
    fi
  done < <(env | awk -F= -v prefix="$ENV_PREFIX" '$1 ~ "^"prefix {print $1}')
else
  # Specific host: process ENV_HOSTNAME_* variables
  ENV_HOSTNAME_PREFIX="${ENV_PREFIX}$(echo "${HOSTNAME}" | tr '[:lower:]' '[:upper:]')_"
  while IFS= read -r var; do
    if [[ "$var" =~ ^${ENV_HOSTNAME_PREFIX}.+ ]]; then
      var_name="${var#${ENV_HOSTNAME_PREFIX}}"
      var_value="${!var}"
      export "$var_name=$var_value"
    fi
  done < <(env | awk -F= -v prefix="$ENV_HOSTNAME_PREFIX" '$1 ~ "^"prefix {print $1}')
fi

# Set default USER if not already set
export USER="${USER:-deploy}"

# Verify that HOST is defined (skip for build environment)
if [ -z "$HOST" ] && [[ "$ENV" != "build" ]]; then
  echo "::error:: HOST is not defined. Please set it in .env file or as CI secret (${ENV_PREFIX}HOST)"
  exit 1
fi

# Verify that SSH_PRIVATE_KEY is defined (skip for build environment)
if [ -z "$SSH_PRIVATE_KEY" ] && [[ "$ENV" != "build" ]]; then
  echo "::error:: SSH_PRIVATE_KEY is not defined. Please set it as CI secret (${ENV_PREFIX}SSH_PRIVATE_KEY)"
  exit 1
fi

#######################################
######### Export env to YAML ##########
#######################################
echo "Exporting environment variables to /tmp/ansible_env_vars.yml..."

python3 << 'PYTHON_EOF'
import os
import yaml

env_vars = {}
for key, value in os.environ.items():
    if key and key not in ['_', 'OLDPWD']:
        # Convert to lowercase for consistency
        key_lower = key.lower()
        env_vars[key_lower] = value

# Write as proper YAML with multiline support
with open('/tmp/ansible_env_vars.yml', 'w') as f:
    yaml.dump(env_vars, f, default_flow_style=False, allow_unicode=True)
PYTHON_EOF

echo "✓ Environment variables exported to /tmp/ansible_env_vars.yml"
