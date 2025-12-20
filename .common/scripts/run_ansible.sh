#!/bin/bash

# This script handles the SSH setup and Ansible deployment
# It expects the following environment variables to be set (provided by CLI):
# - SSH_PRIVATE_KEY: The SSH private key for remote access
# - DOCKFLOW_HOST: The target host
# - DOCKFLOW_USER: The SSH user
# - DOCKFLOW_PORT: The SSH port (default: 22)
# - ENV: The environment (production, staging, etc.)
# - SERVER_NAME: The server name being deployed to
# - VERSION: The version being deployed
# - ROOT_PATH: The root path of the project
# - DOCKFLOW_PATH: Path to dockflow (defaults to /tmp/dockflow)

set -e

######### Change working directory #########
DOCKFLOW_PATH="${DOCKFLOW_PATH:-/tmp/dockflow}"
cd "$DOCKFLOW_PATH" || exit 1

#######################################
############ Validation ###############
#######################################

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Dockflow Deployment"
echo "═══════════════════════════════════════════════════"
echo "  Environment: ${ENV}"
echo "  Server: ${SERVER_NAME}"
echo "  Version: ${VERSION}"
echo "  Host: ${DOCKFLOW_HOST}:${DOCKFLOW_PORT:-22}"
echo "  User: ${DOCKFLOW_USER}"
echo "═══════════════════════════════════════════════════"
echo ""

# Validate required variables
[[ -z "$DOCKFLOW_HOST" ]] && echo "::error:: DOCKFLOW_HOST is not defined" && exit 1
[[ -z "$DOCKFLOW_USER" ]] && echo "::error:: DOCKFLOW_USER is not defined" && exit 1
[[ -z "$SSH_PRIVATE_KEY" ]] && echo "::error:: SSH_PRIVATE_KEY is not defined" && exit 1

# Set defaults
export DOCKFLOW_PORT="${DOCKFLOW_PORT:-22}"

#######################################
######## Prepare Environment ##########
#######################################

# Convert Windows line endings in .deployment files
if [ -d "$ROOT_PATH/.deployment" ]; then
	find "$ROOT_PATH/.deployment" -type f -exec sed -i 's/\r$//' {} \; 2>/dev/null || true
fi

# Export environment variables to YAML for Ansible
echo "Exporting environment variables to /tmp/ansible_env_vars.yml..."
python3 <<'PYTHON_EOF'
import os, yaml
env_vars = {k.lower(): v for k, v in os.environ.items() if k}
with open('/tmp/ansible_env_vars.yml', 'w') as f:
    yaml.dump(env_vars, f, default_flow_style=False, allow_unicode=True)
PYTHON_EOF

#######################################
############ Setup SSH Key ############
#######################################

mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" | tr -d '\r' >~/.ssh/dockflow_deploy_key
chmod 600 ~/.ssh/dockflow_deploy_key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/dockflow_deploy_key

#######################################
######### Deploy with Ansible #########
#######################################

SKIP_TAGS="configure_host"
if [ ! -d "$ROOT_PATH/.deployment/templates/nginx" ] || [ -z "$(ls -A "$ROOT_PATH"/.deployment/templates/nginx 2>/dev/null)" ]; then
	echo "No nginx configuration found, skipping nginx role"
	SKIP_TAGS="${SKIP_TAGS},nginx"
fi

# Use server name for inventory host (more explicit than hostname)
INVENTORY_HOST="${ENV}-${SERVER_NAME}"

sed -i "s/REMOTE_HOST/${INVENTORY_HOST}/g" ansible/inventory.yml
ansible-galaxy role install geerlingguy.docker

# Build extra vars for Ansible
EXTRA_VARS=()
if [ "${SKIP_DOCKER_INSTALL}" = "true" ]; then
	EXTRA_VARS+=("-e" "skip_docker_install=true")
fi
if [ "${FORCE_DEPLOY}" = "true" ]; then
	EXTRA_VARS+=("-e" "force_unlock=true")
fi

ansible-playbook ansible/deploy.yml -i ansible/inventory.yml --skip-tags "$SKIP_TAGS" "${EXTRA_VARS[@]}"
