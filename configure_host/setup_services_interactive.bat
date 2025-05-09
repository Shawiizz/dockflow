@echo off
setlocal enabledelayedexpansion
echo == Configuring playbook execution ==

set /p HOST="Target VM IP (HOST): "
set /p ANSIBLE_USER="Ansible user name (ANSIBLE_USER) [default: ansible]: "
if "!ANSIBLE_USER!"=="" set ANSIBLE_USER=ansible
set /p ANSIBLE_BECOME_PASSWORD="Ansible user password (ANSIBLE_BECOME_PASSWORD): "

set /p INSTALL_PORTAINER="Do you want to install Portainer? (y/n): "

set ENV_ARGS=-e HOST=!HOST! -e ANSIBLE_BECOME_PASSWORD=!ANSIBLE_BECOME_PASSWORD! -e ANSIBLE_USER=!ANSIBLE_USER!
set ENV_ARGS_PORTAINER=

if /i "!INSTALL_PORTAINER!"=="y" (
    set /p PORTAINER_PASSWORD="Portainer password: "
    set /p PORTAINER_HTTP_PORT="Port HTTP for Portainer (PORTAINER_HTTP_PORT) [default: 9000]: "
    if "!PORTAINER_HTTP_PORT!"=="" set PORTAINER_HTTP_PORT=9000
    set /p PORTAINER_DOMAIN_NAME="Portainer domain name (PORTAINER_DOMAIN_NAME): "

    set ENV_ARGS_PORTAINER=-e PORTAINER_INSTALL=true -e PORTAINER_PASSWORD=!PORTAINER_PASSWORD! -e PORTAINER_HTTP_PORT=!PORTAINER_HTTP_PORT! -e PORTAINER_DOMAIN_NAME=!PORTAINER_DOMAIN_NAME!
)

echo.
echo == Executing docker compose command ==
echo docker-compose -f configure_host/docker-compose.yml run --rm !ENV_ARGS! !ENV_ARGS_PORTAINER! ansible
echo.

docker-compose -f configure_host/docker-compose.yml run --rm !ENV_ARGS! !ENV_ARGS_PORTAINER! ansible