#!/bin/bash

setup_machine() {
    echo -e "${GREEN}=========================================================="
    echo "   SETUP REMOTE MACHINE FOR DEPLOYMENT"
    echo -e "==========================================================${NC}"

    print_heading "REMOTE SERVER INFORMATION"
    read -rp "Remote server IP address: " SERVER_IP
    read -rp "SSH port [default: 22]: " SSH_PORT
    SSH_PORT=${SSH_PORT:-22}

    export SERVER_IP
    export SSH_PORT

    read -rp "Do you want to setup an Ansible user? (y/n) [default: y]: " SETUP_USER
    SETUP_USER=${SETUP_USER:-y}

    if [ "$SETUP_USER" = "y" ] || [ "$SETUP_USER" = "Y" ]; then
        get_ssh_connection
        setup_ansible_user
        generate_ansible_ssh_key
        USER_NEEDS_SETUP=true
    else
        print_heading "EXISTING USER INFORMATION"
        read -rp "User name: " USER
        read -srp "Sudo (become) password for user: " USER_PASSWORD
        echo ""
        export USER
        export USER_PASSWORD
        
        print_heading "SSH KEY FOR USER"
        
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
    echo "Remote server: $SERVER_IP:$SSH_PORT"
    echo "Remote user: $REMOTE_USER"
    echo "Authentication method: $AUTH_METHOD"
    echo "Deployment user: $USER"
    if [ "$USER_NEEDS_SETUP" = true ]; then
        echo "Deployment user will be created: Yes"
    else
        echo "Using existing deployment user: Yes"
    fi

    read -rp "Do you want to proceed with this configuration? (y/n) [default: y]: " PROCEED
    PROCEED=${PROCEED:-y}

    if [ "$PROCEED" != "y" ] && [ "$PROCEED" != "Y" ]; then
        print_warning "Setup aborted by user."
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
