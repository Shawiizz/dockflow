#!/bin/bash

# Add private ssh host key
mkdir -p ~/.ssh
cat ssh/configure_host_private_key | tr -d '\r' > ~/.ssh/private_key
chmod 600 ~/.ssh/private_key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/private_key

# Determine skip tags
SKIP_TAGS="deploy"
if [ "$PORTAINER_INSTALL" != "true" ]; then
  echo "PORTAINER_INSTALL is not 'true', skipping Portainer installation"
  SKIP_TAGS="$SKIP_TAGS,portainer"
fi

# Run ansible playbook
export ANSIBLE_HOST_KEY_CHECKING=False
ansible-galaxy role install geerlingguy.docker
ansible-playbook configure_host.yml -i "$HOST," --user="$ANSIBLE_USER" --private-key=ssh/configure_host_private_key --skip-tags "$SKIP_TAGS"
