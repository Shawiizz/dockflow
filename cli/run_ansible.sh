#!/bin/bash

source "$(dirname "$0")/functions.sh"

configure_services() {
    print_heading "CONFIGURING SERVICES"
    
    read -rp "Do you want to install Portainer? (y/n): " INSTALL_PORTAINER
    
    if [[ "$INSTALL_PORTAINER" == "y" || "$INSTALL_PORTAINER" == "Y" ]]; then
        read -srp "Portainer password: " PORTAINER_PASSWORD
        echo ""
        read -rp "Port HTTP for Portainer [default: 9000]: " PORTAINER_HTTP_PORT
        PORTAINER_HTTP_PORT=${PORTAINER_HTTP_PORT:-9000}
        read -rp "Portainer domain name: " PORTAINER_DOMAIN_NAME
        
        export PORTAINER_INSTALL=true
        export PORTAINER_PASSWORD
        export PORTAINER_HTTP_PORT
        export PORTAINER_DOMAIN_NAME
    fi
}

run_ansible_playbook() {
    print_heading "EXECUTING ANSIBLE PLAYBOOK DIRECTLY"
    
    echo "Setting up SSH key for Ansible..."
    # Ensure the key doesn't have Windows CRLF line endings
    if [ -f ~/.ssh/ansible_key ]; then
        cat ~/.ssh/ansible_key | tr -d '\r' > ~/.ssh/ansible_key.tmp
        mv ~/.ssh/ansible_key.tmp ~/.ssh/ansible_key
        chmod 600 ~/.ssh/ansible_key
    fi
    eval "$(ssh-agent -s)"
    ssh-add ~/.ssh/ansible_key
    
    # Determine skip tags
    SKIP_TAGS="deploy"
    if [[ "$INSTALL_PORTAINER" != "y" && "$INSTALL_PORTAINER" != "Y" ]]; then
        SKIP_TAGS="$SKIP_TAGS,portainer,nginx"
    fi
    
    export HOST=$SERVER_IP
    export ANSIBLE_USER
    export ANSIBLE_BECOME_PASSWORD=$ANSIBLE_PASSWORD
    
    echo "Running Ansible playbook..."
    export ANSIBLE_HOST_KEY_CHECKING=False
    ansible-galaxy role install geerlingguy.docker
    
    cd "$CLI_SCRIPT_DIR/.." || exit 1
    ansible-playbook configure_host.yml -i "$HOST," --user="$ANSIBLE_USER" --private-key=~/.ssh/ansible_key --skip-tags "$SKIP_TAGS"
}

display_completion() {
    echo -e "\n${GREEN}==========================================================="
    echo "   REMOTE MACHINE SETUP COMPLETED"
    echo -e "===========================================================${NC}"
    echo ""
    echo -e "${YELLOW}Here is the SSH private key for ansible user (keep it secure):${NC}"
    cat ~/.ssh/ansible_key
    echo ""
    echo -e "${GREEN}The machine is now ready to receive deployments of Docker applications.${NC}"
}

CLI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
