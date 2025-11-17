#!/bin/bash

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
        cat ~/.ssh/deploy_key | tr -d '\r' > ~/.ssh/deploy_key.tmp
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
    
    export HOST=$SERVER_IP
    export PORT=$SSH_PORT
    export USER
    export USER_PASSWORD
    
    echo "Running Ansible playbook..."
    export ANSIBLE_HOST_KEY_CHECKING=False
    ansible-galaxy role install geerlingguy.docker
    
    cd "$CLI_ROOT_DIR/.." || exit 1
    ansible-playbook ansible/configure_host.yml -i "$HOST," --user="$USER" --private-key=~/.ssh/deploy_key --skip-tags "$SKIP_TAGS" --extra-vars "skip_docker_install=${SKIP_DOCKER_INSTALL:-false}"
    
    # Check if Ansible playbook execution was successful
    ANSIBLE_RETURN_CODE=$?
    if [ $ANSIBLE_RETURN_CODE -ne 0 ]; then
        echo -e "${RED}==========================================================="
        echo "   ANSIBLE PLAYBOOK FAILED!"
        echo -e "===========================================================${NC}"
        echo -e "${YELLOW}The setup process encountered errors. Please check the logs above for details.${NC}"
        echo ""
        echo -e "${YELLOW}Here is the SSH private key for deployment user $USER (keep it secure):${NC}"
        
        # Retrieve the private key from the remote server
        if [ "${SERVER_IP:-}" = "127.0.0.1" ] || [ "${SERVER_IP:-}" = "localhost" ]; then
            # Local - read directly
            if [ "$USER" != "$(whoami)" ]; then
                echo "${BECOME_PASSWORD}" | sudo -S cat "/home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
            else
                cat "$HOME/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
            fi
        else
            # Remote - retrieve via SSH
            if [ "${AUTH_METHOD:-}" = "password" ] && command -v sshpass &> /dev/null; then
                SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh -p "${SSH_PORT:-22}" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo cat /home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
            elif [ -n "${SSH_PRIVATE_KEY_PATH:-}" ]; then
                ssh -p "${SSH_PORT:-22}" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo cat /home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
            fi
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
    echo -e "${YELLOW}Here is the SSH private key for deployment user $USER (keep it secure):${NC}"
    
    # Retrieve the private key from the remote server
    if [ "${SERVER_IP:-}" = "127.0.0.1" ] || [ "${SERVER_IP:-}" = "localhost" ]; then
        # Local - read directly
        if [ "$USER" != "$(whoami)" ]; then
            echo "${BECOME_PASSWORD}" | sudo -S cat "/home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
        else
            cat "$HOME/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
        fi
    else
        # Remote - retrieve via SSH
        if [ "${AUTH_METHOD:-}" = "password" ] && command -v sshpass &> /dev/null; then
            SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh -p "${SSH_PORT:-22}" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo cat /home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
        elif [ -n "${SSH_PRIVATE_KEY_PATH:-}" ]; then
            ssh -p "${SSH_PORT:-22}" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo cat /home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
        fi
    fi
    
    echo ""
    echo -e "${GREEN}The machine is now ready to receive deployments of Docker applications.${NC}"
}
