#!/bin/bash

echo "== Configuring playbook execution =="

read -rp "Target VM IP (HOST) : " HOST
read -rp "Ansible user name (ANSIBLE_USER) [default: ansible] : " ANSIBLE_USER
ANSIBLE_USER=${ANSIBLE_USER:-ansible}
read -srp "Ansible user password (ANSIBLE_BECOME_PASSWORD) : " ANSIBLE_BECOME_PASSWORD
echo ""

read -rp "Do you want to install Portainer? (y/n) : " INSTALL_PORTAINER

ENV_ARGS="-e HOST=$HOST -e ANSIBLE_BECOME_PASSWORD=$ANSIBLE_BECOME_PASSWORD -e ANSIBLE_USER=$ANSIBLE_USER"

if [[ "$INSTALL_PORTAINER" == "y" || "$INSTALL_PORTAINER" == "Y" ]]; then
  read -srp "Portainer password : " PORTAINER_PASSWORD
  echo ""
  read -rp "Port HTTP for Portainer (PORTAINER_HTTP_PORT) [default: 9000] : " PORTAINER_HTTP_PORT
  PORTAINER_HTTP_PORT=${PORTAINER_HTTP_PORT:-9000}
  read -rp "Portainer domain name (PORTAINER_DOMAIN_NAME) : " PORTAINER_DOMAIN_NAME

  ENV_ARGS+=" -e PORTAINER_INSTALL=true"
  ENV_ARGS+=" -e PORTAINER_PASSWORD=$PORTAINER_PASSWORD"
  ENV_ARGS+=" -e PORTAINER_HTTP_PORT=$PORTAINER_HTTP_PORT"
  ENV_ARGS+=" -e PORTAINER_DOMAIN_NAME=$PORTAINER_DOMAIN_NAME"
fi

echo ""
echo "== Executing docker compose command =="
echo "docker-compose -f configure_host/docker-compose.yml run --rm $ENV_ARGS ansible"
echo ""

eval docker-compose -f configure_host/docker-compose.yml run --rm $ENV_ARGS ansible
