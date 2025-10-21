#!/bin/bash

source "$CLI_UTILS_DIR/functions.sh"

configure_services() {
    print_heading "CONFIGURING SERVICES"
    
    read -rp "Do you want to install Portainer? (y/n) [default: n]: " INSTALL_PORTAINER
    
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
    print_heading "EXECUTING ANSIBLE PLAYBOOK"
    
    echo "Setting up SSH key for Ansible..."
    # Ensure the key doesn't have Windows CRLF line endings
    if [ -f ~/.ssh/deploy_key ]; then
        cat ~/.ssh/deploy_key | tr -d '\r' > ~/.ssh/deploy_key.tmp
        mv ~/.ssh/deploy_key.tmp ~/.ssh/deploy_key
        chmod 600 ~/.ssh/deploy_key
    fi
    eval "$(ssh-agent -s)"
    ssh-add ~/.ssh/deploy_key
    
    # Determine skip tags
    SKIP_TAGS="deploy"
    if [[ "$INSTALL_PORTAINER" != "y" && "$INSTALL_PORTAINER" != "Y" ]]; then
        SKIP_TAGS="$SKIP_TAGS,portainer,nginx"
    fi
    
    export HOST=$SERVER_IP
    export USER
    export USER_PASSWORD
    
    echo "Running Ansible playbook..."
    export ANSIBLE_HOST_KEY_CHECKING=False
    ansible-galaxy role install geerlingguy.docker
    
    cd "$CLI_ROOT_DIR/.." || exit 1
    ansible-playbook ansible/configure_host.yml -i "$HOST," --user="$USER" --private-key=~/.ssh/deploy_key --skip-tags "$SKIP_TAGS"
    
    # Check if Ansible playbook execution was successful
    ANSIBLE_RETURN_CODE=$?
    if [ $ANSIBLE_RETURN_CODE -ne 0 ]; then
        echo -e "${RED}==========================================================="
        echo "   ANSIBLE PLAYBOOK FAILED!"
        echo -e "===========================================================${NC}"
        echo -e "${YELLOW}The setup process encountered errors. Please check the logs above for details.${NC}"
        echo ""
        echo -e "${YELLOW}Here is the SSH private key for deployment user (keep it secure):${NC}"
        if [ -f ~/.ssh/deploy_key ]; then
            cat ~/.ssh/deploy_key
        fi
        echo ""
        echo -e "${RED}You need to investigate and fix the errors before the machine can receive deployments.${NC}"
        echo -e "${YELLOW}Once fixed, you may need to re-run the setup process.${NC}"
        exit 1
    fi
}

display_completion() {
    echo -e "\n${GREEN}==========================================================="
    echo "   REMOTE MACHINE SETUP COMPLETED"
    echo -e "===========================================================${NC}"
    echo ""
    echo -e "${YELLOW}Here is the SSH private key for deployment user (keep it secure):${NC}"
    cat ~/.ssh/deploy_key
    echo ""
    echo -e "${GREEN}The machine is now ready to receive deployments of Docker applications.${NC}"
}
