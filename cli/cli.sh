#!/bin/bash

CLI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$CLI_SCRIPT_DIR/functions.sh"
source "$CLI_SCRIPT_DIR/setup_ssh.sh"
source "$CLI_SCRIPT_DIR/create_ansible_user.sh"
source "$CLI_SCRIPT_DIR/run_ansible.sh"

trap cleanup SIGINT

echo -e "${GREEN}=========================================================="
echo "   SETUP REMOTE MACHINE FOR DEPLOYMENT"
echo -e "==========================================================${NC}"

print_heading "REMOTE SERVER INFORMATION"
read -rp "Remote server IP address: " SERVER_IP
read -rp "SSH port [default: 22]: " SSH_PORT
SSH_PORT=${SSH_PORT:-22}

export SERVER_IP
export SSH_PORT

get_ssh_connection
setup_ansible_user
generate_ansible_ssh_key

print_heading "CONFIGURATION SUMMARY"
echo "Remote server: $SERVER_IP:$SSH_PORT"
echo "Remote user: $REMOTE_USER"
echo "Authentication method: $AUTH_METHOD"
echo "Ansible user to create: $ANSIBLE_USER"

read -rp "Do you want to proceed with this configuration? (y/n) [default: y]: " PROCEED
PROCEED=${PROCEED:-y}

if [ "$PROCEED" != "y" ] && [ "$PROCEED" != "Y" ]; then
    print_warning "Setup aborted by user."
    exit 0
fi

create_ansible_user_on_remote
configure_services
run_ansible_playbook
display_completion
