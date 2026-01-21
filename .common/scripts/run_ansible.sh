#!/bin/bash

# Dockflow Ansible Runner
# 
# This script runs Ansible deployment with minimal shell logic.
# All configuration is provided via:
#   - /tmp/dockflow_context.json (mounted by CLI)
#   - /tmp/dockflow_key (SSH key, mounted by CLI)
#
# The inventory.py script reads the JSON context directly,
# eliminating the need for shell variable exports.

set -e

DOCKFLOW_PATH="${DOCKFLOW_PATH:-/tmp/dockflow}"
CONTEXT_FILE="/tmp/dockflow_context.json"
SSH_KEY_FILE="/tmp/dockflow_key"

cd "$DOCKFLOW_PATH" || exit 1

#######################################
######## Validate Requirements ########
#######################################

if [ ! -f "$CONTEXT_FILE" ]; then
    echo "::error:: Context file not found: $CONTEXT_FILE"
    echo "  The CLI should mount this file into the container."
    exit 1
fi

if [ ! -f "$SSH_KEY_FILE" ]; then
    echo "::error:: SSH key file not found: $SSH_KEY_FILE"
    echo "  The CLI should mount this file into the container."
    exit 1
fi

#######################################
######## Prepare Environment ##########
#######################################

source "$DOCKFLOW_PATH/.common/scripts/prepare_env.sh"

#######################################
############ Setup SSH ################
#######################################

# Copy key to ~/.ssh (ssh-add requires file in standard location)
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cp "$SSH_KEY_FILE" ~/.ssh/dockflow_deploy_key
chmod 600 ~/.ssh/dockflow_deploy_key

# Start SSH agent and add key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/dockflow_deploy_key

#######################################
######### Deploy with Ansible #########
#######################################

# Determine skip tags
SKIP_TAGS="configure_host"
if [ ! -d "$ROOT_PATH/.deployment/templates/nginx" ] || [ -z "$(ls -A "$ROOT_PATH"/.deployment/templates/nginx 2>/dev/null)" ]; then
    echo "No nginx configuration found, skipping nginx role"
    SKIP_TAGS="${SKIP_TAGS},nginx"
fi

# Install required Ansible roles
ansible-galaxy role install geerlingguy.docker

# Run Ansible with dynamic inventory and JSON context
# - inventory.py reads connection info from context JSON
# - --extra-vars loads all variables from context JSON
ansible-playbook ansible/deploy.yml \
    -i ansible/inventory.py \
    -e "@${CONTEXT_FILE}" \
    --skip-tags "$SKIP_TAGS"
