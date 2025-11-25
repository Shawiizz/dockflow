#!/bin/bash

setup_machine() {
    echo -e "${GREEN}=========================================================="
    echo "   SETUP LOCAL MACHINE FOR DEPLOYMENT"
    echo -e "==========================================================${NC}"

    export SERVER_IP="127.0.0.1"
    
    # Detect public IP for default value
    DETECTED_IP=$(detect_public_ip)
    
    # Prompt for Public IP/Hostname for connection string
    echo ""
    echo -e "${CYAN}Please enter the Public IP or Hostname of this machine.${NC}"
    echo -e "${GRAY}This will be used to generate the connection string for your CI/CD pipeline.${NC}"
    prompt_host "Public Host" PUBLIC_HOST "$DETECTED_IP"
    
    # Detect SSH port
    DETECTED_PORT=$(detect_ssh_port)
    prompt_port "SSH Port" SSH_PORT "$DETECTED_PORT"
    export SSH_PORT

    echo ""
    if confirm_action "Do you want to setup a deployment user?" "y"; then
        SETUP_USER="y"
    else
        SETUP_USER="n"
    fi

    if [ "$SETUP_USER" = "y" ] || [ "$SETUP_USER" = "Y" ]; then
        setup_ansible_user
        generate_ansible_ssh_key
        USER_NEEDS_SETUP=true
    else
        print_heading "EXISTING USER INFORMATION"
        
        # Default to current user
        CURRENT_USER=$(whoami)
        prompt_username "User name" DOCKFLOW_USER "$CURRENT_USER"
        export DOCKFLOW_USER
        
        # Prompt for sudo password
        prompt_and_validate_sudo_password
        
        print_heading "SSH KEY FOR USER"
        echo ""
        
        # Smart SSH key handling for current user
        if [ "$DOCKFLOW_USER" = "$CURRENT_USER" ]; then
            USER_SSH_KEY="$HOME/.ssh/dockflow_key"
            SHOULD_GENERATE=false
            
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
                print_success "SSH key generated successfully"
            fi
            
            # Ensure the key is in authorized_keys for local SSH
            mkdir -p ~/.ssh
            if ! grep -q "$(cat "${USER_SSH_KEY}.pub")" ~/.ssh/authorized_keys 2>/dev/null; then
                cat "${USER_SSH_KEY}.pub" >> ~/.ssh/authorized_keys
                chmod 600 ~/.ssh/authorized_keys
                print_success "Added key to authorized_keys for local access"
            fi
            
            export USER_PRIVATE_KEY_PATH="$USER_SSH_KEY"
        else
            # Fallback for different user (unlikely but possible)
            local options=(
                "Use existing SSH key file (select from available keys)"
                "Paste SSH private key directly"
                "Generate new SSH key"
            )
            
            interactive_menu "Choose an option:" "${options[@]}"
            SSH_KEY_OPTION=$?
            
            if [ "$SSH_KEY_OPTION" = "0" ]; then
                if ! list_and_select_ssh_key; then
                    print_warning "No SSH key selected or available. Exiting..."
                    exit 1
                fi
                USER_KEY_PATH="$SSH_PRIVATE_KEY_PATH"
                chmod 600 "$USER_KEY_PATH"
                export USER_PRIVATE_KEY_PATH="$USER_KEY_PATH"
            elif [ "$SSH_KEY_OPTION" = "1" ]; then
                print_warning "Please paste your SSH private key for the user (end with a new line followed by EOF):"
                mkdir -p ~/.ssh
                rm -f ~/.ssh/deploy_key
                while IFS= read -r line; do
                    [[ "$line" == "EOF" ]] && break
                    echo "$line" >> ~/.ssh/deploy_key
                done
                chmod 600 ~/.ssh/deploy_key
                print_success "SSH key saved to ~/.ssh/deploy_key"
            else
                generate_ansible_ssh_key
            fi
        fi
        
        USER_NEEDS_SETUP=false
    fi

    print_heading "CONFIGURATION SUMMARY"
    echo ""
    echo -e "${CYAN}Target:${NC} Local Machine"
    echo -e "${CYAN}Public Host (for connection string):${NC} $PUBLIC_HOST"
    echo -e "${CYAN}SSH Port:${NC} $SSH_PORT"
    echo -e "${CYAN}Deployment user:${NC} $DOCKFLOW_USER"
    if [ "$USER_NEEDS_SETUP" = true ]; then
        echo -e "${CYAN}Deployment user will be created:${NC} Yes"
    else
        echo -e "${CYAN}Using existing deployment user:${NC} Yes"
    fi
    echo ""

    if ! confirm_action "Do you want to proceed with this configuration?" "y"; then
        print_warning "Setup aborted by user"
        exit 0
    fi

    if [ "$USER_NEEDS_SETUP" = true ]; then
        create_ansible_user_locally
    fi

    configure_services
    run_ansible_playbook
    display_completion
}

display_completion() {
    print_heading "SETUP COMPLETE"
    
    echo -e "${GREEN}The machine has been successfully configured!${NC}"
    echo ""
    
    # Display connection string
    display_deployment_connection_info "$PUBLIC_HOST" "$SSH_PORT" "$DOCKFLOW_USER" "$DOCKFLOW_PASSWORD"
}

export -f setup_machine
