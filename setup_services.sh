#!/bin/bash

if [ -z "$ENV" ]; then
  echo "ENV variable is not set. Please set it to 'production' or 'staging'."
  exit 1
fi

# Determine which key file to use based on environment
if [ "$ENV" = "production" ]; then
  PRIVATE_KEY_FILE="ssh/production_private_key"
  INVENTORY_GROUP="production"
  echo "Using production environment"
elif [ "$ENV" = "staging" ]; then
  PRIVATE_KEY_FILE="ssh/staging_private_key"
  INVENTORY_GROUP="staging"
  echo "Using staging environment"
else
  echo "Invalid ENV value: $ENV. Must be 'production' or 'staging'."
  exit 1
fi

# Add private ssh host key
mkdir -p ~/.ssh
cat $PRIVATE_KEY_FILE | tr -d '\r' > ~/.ssh/private_key
chmod 600 ~/.ssh/private_key
eval `ssh-agent -s`
ssh-add ~/.ssh/private_key

# Handle portainer password
if [ -z "$PORTAINER_PASSWORD" ]; then
  echo "Portainer password is empty, setting it to default value 'azerty'"
  export PORTAINER_PASSWORD="azerty"
else
  echo "Portainer password is set to '$PORTAINER_PASSWORD'"
fi

# Run ansible playbook
export ANSIBLE_HOST_KEY_CHECKING=False
ansible-playbook configure_host.yml -i hosts --limit $INVENTORY_GROUP --skip-tags "deploy,compose"