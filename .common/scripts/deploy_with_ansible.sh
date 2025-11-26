#!/bin/bash

# This script handles the SSH setup and Ansible deployment
# It expects the following environment variables to be set:
# - SSH_PRIVATE_KEY: The SSH private key for remote access
# - ENV: The environment (production, staging, etc.)
# - HOSTNAME: The hostname to deploy to
# - ROOT_PATH: The root path of the project
# - SKIP_NGINX_CHECK: Optional, set to "true" to skip nginx configuration check

######### Change working directory #########
cd "$ROOT_PATH/dockflow" || exit 1

#######################################
############ Setup SSH Key ############
#######################################

mkdir -p ssh
printf '%s\n' "$SSH_PRIVATE_KEY" | tr -d '\r' >ssh/remote_private_key
chmod 600 ssh/*
eval "$(ssh-agent -s)"
ssh-add ssh/remote_private_key

#######################################
######### Deploy with Ansible #########
#######################################

SKIP_TAGS="configure_host"
if [ ! -d "../.deployment/templates/nginx" ] || [ -z "$(ls -A ../.deployment/templates/nginx 2>/dev/null)" ]; then
	echo "No nginx configuration found, skipping nginx role"
	SKIP_TAGS="${SKIP_TAGS},nginx"
fi

INVENTORY_HOST="${ENV}$([[ "$HOSTNAME" != "main" ]] && echo "-${HOSTNAME}" || echo "")"

sed -i "s/REMOTE_HOST/${INVENTORY_HOST}/g" ansible/inventory.yml
ansible-galaxy role install geerlingguy.docker

# Build extra vars for Ansible
EXTRA_VARS=""
if [ "${SKIP_DOCKER_INSTALL}" = "true" ]; then
	EXTRA_VARS="-e skip_docker_install=true"
fi

ansible-playbook ansible/deploy.yml -i ansible/inventory.yml --skip-tags "$SKIP_TAGS" "$EXTRA_VARS"
