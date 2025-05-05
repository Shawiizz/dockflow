#!/bin/bash

# Add private ssh host key
mkdir -p ~/.ssh
cat ssh/configure_host_private_key | tr -d '\r' > ~/.ssh/private_key
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
ansible-galaxy role install geerlingguy.docker
ansible-playbook configure_host.yml -i "$HOST," --user="$ANSIBLE_USER" --private-key=ssh/configure_host_private_key --skip-tags "deploy"

echo "ansible-playbook configure_host.yml -i $HOST, --user=$ANSIBLE_USER --private-key=ssh/configure_host_private_key --skip-tags deploy"