#!/bin/bash
set -eo pipefail
IFS=$'\n\t'

setup_machine_interactive() {
    echo -e "${GREEN}=========================================================="
    echo "   MACHINE SETUP"
    echo -e "==========================================================${NC}"
    
    print_heading "SETUP TYPE"
    echo ""
    echo -e "${CYAN}Choose the type of setup:${NC}"
    echo ""
    
    local options=(
        "Setup a remote machine (via SSH)"
        "Setup this local machine (localhost)"
        "Display connection information for existing user"
    )
    
    interactive_menu "Select setup type:" "${options[@]}"
    SETUP_TYPE=$?
    
    if [ "$SETUP_TYPE" = "0" ]; then
        # Remote setup - normal flow
        setup_machine
    elif [ "$SETUP_TYPE" = "1" ]; then
        # Local setup - pre-fill variables and use normal flow
        echo ""
        echo -e "${CYAN}Setting up the current machine for Docker deployment...${NC}"
        echo ""
        
        # Get current user
        CURRENT_USER=$(whoami)
        
        echo -e "${CYAN}Detected configuration:${NC}"
        echo -e "${BLUE}  • Current user:${NC} $CURRENT_USER"
        echo ""
        
        # Try to get the real IP address of the server for connection string
        DEFAULT_IP="127.0.0.1"
        # Try to get public IP first
        PUBLIC_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s -4 icanhazip.com 2>/dev/null || curl -s -4 api.ipify.org 2>/dev/null)
        if [ -n "$PUBLIC_IP" ] && [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            DEFAULT_IP="$PUBLIC_IP"
        else
            # Fallback to local IP
            LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')
            if [ -n "$LOCAL_IP" ] && [[ "$LOCAL_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                DEFAULT_IP="$LOCAL_IP"
            fi
        fi
        
        # Try to get the real SSH port from configuration
        DEFAULT_SSH_PORT="22"
        # Check SSH config file
        if [ -f /etc/ssh/sshd_config ]; then
            CONFIG_PORT=$(grep -E "^Port " /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
            if [ -n "$CONFIG_PORT" ] && [[ "$CONFIG_PORT" =~ ^[0-9]+$ ]]; then
                DEFAULT_SSH_PORT="$CONFIG_PORT"
            fi
        fi
        # Alternatively, check which port sshd is listening on
        if [ "$DEFAULT_SSH_PORT" = "22" ]; then
            LISTENING_PORT=$(ss -tlnp 2>/dev/null | grep sshd | grep -oP ':\K[0-9]+' | head -1)
            if [ -n "$LISTENING_PORT" ] && [[ "$LISTENING_PORT" =~ ^[0-9]+$ ]]; then
                DEFAULT_SSH_PORT="$LISTENING_PORT"
            fi
        fi
        
        # Ask for server details (for connection string)
        echo -e "${CYAN}Server connection details (for connection string):${NC}"
        prompt_host "Server IP address" REAL_SERVER_IP "$DEFAULT_IP"
        prompt_port "SSH port" REAL_SSH_PORT "$DEFAULT_SSH_PORT"
        echo ""
        
        # Pre-fill the server variables for local connection
        export SERVER_IP="127.0.0.1"
        export SSH_PORT="22"
        export REMOTE_USER="$CURRENT_USER"
        
        # Store real server details for connection string
        export REAL_SERVER_IP
        export REAL_SSH_PORT
        
        # Pre-fill authentication for local connection (no password needed, using local connection)
        export REMOTE_USER="$CURRENT_USER"
        export AUTH_METHOD="local"
        
        # Ask if user wants to create a deployment user
        echo ""
        if confirm_action "Do you want to create or modify a dedicated deployment user (dockflow)?" "y"; then
            SETUP_USER="y"
        else
            SETUP_USER="n"
        fi
        
        if [ "$SETUP_USER" = "y" ] || [ "$SETUP_USER" = "Y" ]; then
            # User wants to create a deployment user
            setup_ansible_user
            generate_ansible_ssh_key
            USER_NEEDS_SETUP=true
            
            # For local, we'll create the user with Ansible
            # The user will be created during the playbook run
        else
            # Use current user for deployment
            print_heading "USING CURRENT USER FOR DEPLOYMENT"
            
            export DOCKFLOW_USER="$CURRENT_USER"
            
            # Generate SSH key if needed for current user
            SHOULD_GENERATE=false
            USER_SSH_KEY="$HOME/.ssh/dockflow_key"
            
            if [ ! -f "$USER_SSH_KEY" ]; then
                print_step "Generating SSH key for local deployment (user: $CURRENT_USER)..."
                SHOULD_GENERATE=true
            else
                print_step "SSH key already exists for user $CURRENT_USER at $USER_SSH_KEY"
                echo ""
                if confirm_action "Do you want to regenerate the SSH key?" "n"; then
                    print_warning "Regenerating SSH key..."
                    SHOULD_GENERATE=true
                else
                    print_success "Using existing SSH key"
                fi
            fi
            
            if [ "$SHOULD_GENERATE" = true ]; then
                ssh-keygen -t ed25519 -f "$USER_SSH_KEY" -N "" -C "dockflow-local-$(hostname)"
                cat "${USER_SSH_KEY}.pub" >> ~/.ssh/authorized_keys
                chmod 600 ~/.ssh/authorized_keys
                print_success "SSH key generated successfully"
            fi
            
            # Ensure the key is in authorized_keys for local SSH
            if ! grep -q "$(cat "${USER_SSH_KEY}.pub")" ~/.ssh/authorized_keys 2>/dev/null; then
                cat "${USER_SSH_KEY}.pub" >> ~/.ssh/authorized_keys
                chmod 600 ~/.ssh/authorized_keys
            fi
            
            export USER_PRIVATE_KEY_PATH="$HOME/.ssh/dockflow_key"
            USER_NEEDS_SETUP=false
        fi
        
        print_heading "CONFIGURATION SUMMARY"
        echo ""
        echo -e "${CYAN}Target:${NC} Local machine (127.0.0.1)"
        echo -e "${CYAN}Current user:${NC} $CURRENT_USER"
        echo -e "${CYAN}Deployment user:${NC} $DOCKFLOW_USER"
        if [ "$USER_NEEDS_SETUP" = true ]; then
            echo -e "${CYAN}Deployment user will be created:${NC} Yes"
        else
            echo -e "${CYAN}Using current user for deployment:${NC} Yes"
        fi
        echo ""
        
        if ! confirm_action "Do you want to proceed with this configuration?" "y"; then
            print_warning "Setup aborted by user"
            exit 0
        fi
        
        # Configure services (Portainer, etc.)
        configure_services
        
        # Create deployment user if needed
        if [ "$USER_NEEDS_SETUP" = true ]; then
            create_ansible_user_locally
        fi
        
        # Override the ansible playbook run for local connection
        print_heading "EXECUTING ANSIBLE PLAYBOOK"
        
        SKIP_TAGS="deploy"
        if [[ "$INSTALL_PORTAINER" != "y" && "$INSTALL_PORTAINER" != "Y" && "${PORTAINER_INSTALL:-false}" != "true" ]]; then
            SKIP_TAGS="$SKIP_TAGS,portainer,nginx"
        fi
        
        export DOCKFLOW_HOST=$SERVER_IP
        export DOCKFLOW_PORT=$SSH_PORT
        
        echo "Running Ansible playbook on local machine..."
        export ANSIBLE_HOST_KEY_CHECKING=False
        ansible-galaxy role install geerlingguy.docker
        
        cd "$CLI_ROOT_DIR/.." || exit 1
        
        # Create a temporary inventory file for local setup
        # We can't use "localhost" because the playbook excludes it with "all:!localhost"
        # So we use "local" as the hostname with ansible_connection=local
        TEMP_INVENTORY=$(mktemp)
        cat > "$TEMP_INVENTORY" << EOF
[all]
local ansible_connection=local
EOF
        
        prompt_and_validate_sudo_password
        
        echo ""
        
        # Run ansible playbook with the validated password
        ansible-playbook ansible/configure_host.yml \
            --inventory="$TEMP_INVENTORY" \
            --become \
            --become-method=sudo \
            --extra-vars "ansible_become_password=$BECOME_PASSWORD" \
            --skip-tags="$SKIP_TAGS" \
            --extra-vars "skip_docker_install=${SKIP_DOCKER_INSTALL:-false} ansible_user=$DOCKFLOW_USER"        
            ANSIBLE_RETURN_CODE=$?
        
        # Clear the password from memory
        unset BECOME_PASSWORD
        
        # Clean up temporary inventory
        rm -f "$TEMP_INVENTORY"
        
        if [ $ANSIBLE_RETURN_CODE -eq 0 ]; then
            echo -e "\n${GREEN}==========================================================="
            echo "   LOCAL MACHINE SETUP COMPLETED"
            echo -e "===========================================================${NC}"
            echo ""
            
            # Display connection information with private key and connection string
            # Use real server details if available (for local setup), otherwise use SERVER_IP
            display_deployment_connection_info "${REAL_SERVER_IP:-$SERVER_IP}" "${REAL_SSH_PORT:-$SSH_PORT}" "${DOCKFLOW_USER}" "${DOCKFLOW_PASSWORD}"
            
            echo -e "${GREEN}This machine is now ready to receive deployments of Docker applications.${NC}"
            echo ""
        else
            echo -e "${RED}==========================================================="
            echo "   ANSIBLE PLAYBOOK FAILED!"
            echo -e "===========================================================${NC}"
            echo -e "${YELLOW}The setup process encountered errors. Please check the logs above for details.${NC}"
            echo ""
        fi
        
        echo ""
        read -p "Press Enter to exit..." -n 1 -r
        echo ""
        exit 0
    elif [ "$SETUP_TYPE" = "2" ]; then
        # Display connection information only
        echo ""
        echo -e "${CYAN}Display connection information for an existing deployment user${NC}"
        echo ""
        
        # Try to get the real IP address of the server
        DEFAULT_IP="127.0.0.1"
        # Try to get public IP first
        PUBLIC_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s -4 icanhazip.com 2>/dev/null || curl -s -4 api.ipify.org 2>/dev/null)
        if [ -n "$PUBLIC_IP" ] && [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            DEFAULT_IP="$PUBLIC_IP"
        else
            # Fallback to local IP
            LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')
            if [ -n "$LOCAL_IP" ] && [[ "$LOCAL_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                DEFAULT_IP="$LOCAL_IP"
            fi
        fi
        
        # Ask for server details
        prompt_host "Server IP address (for connection string)" SERVER_IP "$DEFAULT_IP"
        prompt_port "SSH port (for connection string)" SSH_PORT "22"
        
        # Ask for deployment user
        prompt_username "Deployment user name" DISPLAY_USER "dockflow"
        
        echo ""
        
        export SERVER_IP
        export SSH_PORT
        export DOCKFLOW_USER="$DISPLAY_USER"
        
        echo ""
        echo -e "${GREEN}=========================================================="
        echo "   CONNECTION INFORMATION"
        echo -e "===========================================================${NC}"
        echo ""
        
        # Display connection information
        display_deployment_connection_info "${SERVER_IP}" "${SSH_PORT}" "${DOCKFLOW_USER}"
        
        echo ""
        read -p "Press Enter to exit..." -n 1 -r
        echo ""
        exit 0
    else
        print_warning "Invalid option."
        exit 1
    fi
}

export -f setup_machine_interactive
