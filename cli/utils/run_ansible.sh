#!/bin/bash
set -eo pipefail
IFS=$'\n\t'

source "$CLI_UTILS_DIR/functions.sh"

configure_services() {
    print_heading "CONFIGURING SERVICES"
    
    echo -e "${CYAN}Optional: Install Portainer for container management${NC}"
    echo ""
    
    if confirm_action "Do you want to install Portainer?" "n"; then
        INSTALL_PORTAINER="y"
        
        echo ""
        read -srp "Portainer password: " PORTAINER_PASSWORD
        echo ""
        
        echo ""
        prompt_port "HTTP port for Portainer" PORTAINER_HTTP_PORT "9000"
        
        echo ""
        prompt_domain_name "Portainer domain name" PORTAINER_DOMAIN_NAME true
        
        export PORTAINER_INSTALL=true
        export PORTAINER_PASSWORD
        export PORTAINER_HTTP_PORT
        export PORTAINER_DOMAIN_NAME
    else
        INSTALL_PORTAINER="n"
    fi
}

run_ansible_playbook() {
    print_heading "EXECUTING ANSIBLE PLAYBOOK"
    
    echo "Setting up SSH key for Ansible..."
    # Ensure the key doesn't have Windows CRLF line endings
    if [ -f ~/.ssh/deploy_key ]; then
        tr -d '\r' < ~/.ssh/deploy_key > ~/.ssh/deploy_key.tmp
        mv ~/.ssh/deploy_key.tmp ~/.ssh/deploy_key
        chmod 600 ~/.ssh/deploy_key
    fi
    eval "$(ssh-agent -s)"
    ssh-add ~/.ssh/deploy_key
    
    # Determine skip tags
    SKIP_TAGS="deploy"
    if [[ "$INSTALL_PORTAINER" != "y" && "$INSTALL_PORTAINER" != "Y" && "${PORTAINER_INSTALL:-false}" != "true" ]]; then
        SKIP_TAGS="$SKIP_TAGS,portainer,nginx"
    fi
    
    export DOCKFLOW_HOST=$SERVER_IP
    export DOCKFLOW_PORT=$SSH_PORT
    export DOCKFLOW_USER
    export DOCKFLOW_PASSWORD
    
    echo "Running Ansible playbook..."
    export ANSIBLE_HOST_KEY_CHECKING=False
    ansible-galaxy role install geerlingguy.docker
    
    cd "$CLI_ROOT_DIR/.." || exit 1
    ansible-playbook ansible/configure_host.yml -i "$DOCKFLOW_HOST," --user="$DOCKFLOW_USER" --private-key=~/.ssh/deploy_key --skip-tags "$SKIP_TAGS" --extra-vars "skip_docker_install=${SKIP_DOCKER_INSTALL:-false}"
    
    # Check if Ansible playbook execution was successful
    ANSIBLE_RETURN_CODE=$?
    if [ $ANSIBLE_RETURN_CODE -ne 0 ]; then
        echo -e "${RED}==========================================================="
        echo "   ANSIBLE PLAYBOOK FAILED!"
        echo -e "===========================================================${NC}"
        echo -e "${YELLOW}The setup process encountered errors. Please check the logs above for details.${NC}"
        echo ""
        
        # Display connection information even on failure
        display_deployment_connection_info "${SERVER_IP}" "${SSH_PORT}" "${DOCKFLOW_USER}" "${DOCKFLOW_PASSWORD}"
        
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
    
    # Display connection information with private key and connection string
    display_deployment_connection_info "${SERVER_IP}" "${SSH_PORT}" "${DOCKFLOW_USER}" "${DOCKFLOW_PASSWORD}"
    
    echo -e "${GREEN}The machine is now ready to receive deployments of Docker applications.${NC}"
}
