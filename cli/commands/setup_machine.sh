#!/bin/bash

setup_machine() {
    echo -e "${GREEN}=========================================================="
    echo "   SETUP REMOTE MACHINE FOR DEPLOYMENT"
    echo -e "==========================================================${NC}"

    print_heading "REMOTE SERVER INFORMATION"
    
    echo -e "${CYAN}Enter your remote server details:${NC}"
    echo ""
    
    # Use validation functions
    prompt_host "Remote server IP address or hostname" SERVER_IP
    prompt_port "SSH port" SSH_PORT "22"

    export SERVER_IP
    export SSH_PORT

    echo ""
    if confirm_action "Do you want to setup an Ansible user?" "y"; then
        SETUP_USER="y"
    else
        SETUP_USER="n"
    fi

    if [ "$SETUP_USER" = "y" ] || [ "$SETUP_USER" = "Y" ]; then
        get_ssh_connection
        setup_ansible_user
        generate_ansible_ssh_key
        USER_NEEDS_SETUP=true
    else
        print_heading "EXISTING USER INFORMATION"
        
        echo ""
        prompt_username "User name" USER
        
        read -srp "Sudo (become) password for user: " USER_PASSWORD
        echo ""
        echo ""
        
        export USER
        export USER_PASSWORD
        
        print_heading "SSH KEY FOR USER"
        echo ""
        
        local options=(
            "Use existing SSH key file (select from available keys)"
            "Paste SSH private key directly"
            "Generate new SSH key"
        )
        
        interactive_menu "Choose an option:" "${options[@]}"
        SSH_KEY_OPTION=$?
        
        if [ "$SSH_KEY_OPTION" = "0" ]; then
            # Use existing SSH key file with selection
            if ! list_and_select_ssh_key; then
                print_warning "No SSH key selected or available. Exiting..."
                exit 1
            fi
            
            USER_KEY_PATH="$SSH_PRIVATE_KEY_PATH"
            
            if [ ! -f "$USER_KEY_PATH" ]; then
                print_warning "Private key not found at $USER_KEY_PATH. Please check the path and try again."
                exit 1
            fi
            
            # Ensure correct permissions on the selected key
            chmod 600 "$USER_KEY_PATH"
            print_success "Using SSH key: $(basename "$USER_KEY_PATH")"
            
            # Set the path for Ansible to use
            export USER_PRIVATE_KEY_PATH="$USER_KEY_PATH"
        elif [ "$SSH_KEY_OPTION" = "1" ]; then
            # Paste SSH key directly
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
        
        USER_NEEDS_SETUP=false
    fi

    print_heading "CONFIGURATION SUMMARY"
    echo ""
    echo -e "${CYAN}Remote server:${NC} $SERVER_IP:$SSH_PORT"
    echo -e "${CYAN}Remote user:${NC} $REMOTE_USER"
    echo -e "${CYAN}Authentication method:${NC} $AUTH_METHOD"
    echo -e "${CYAN}Deployment user:${NC} $USER"
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
        create_ansible_user_on_remote
    fi

    configure_services
    run_ansible_playbook
    display_completion
}

export -f setup_machine
