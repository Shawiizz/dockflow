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

    read -rp "Do you want to setup an Ansible user? (y/n) [default: y]: " SETUP_ANSIBLE_USER
    SETUP_ANSIBLE_USER=${SETUP_ANSIBLE_USER:-y}

    if [ "$SETUP_ANSIBLE_USER" = "y" ] || [ "$SETUP_ANSIBLE_USER" = "Y" ]; then
        get_ssh_connection
        setup_ansible_user
        generate_ansible_ssh_key
        ANSIBLE_USER_NEEDS_SETUP=true
    else
        print_heading "EXISTING ANSIBLE USER INFORMATION"
        read -rp "Ansible user name: " ANSIBLE_USER
        read -srp "Sudo (become) password for ansible user: " ANSIBLE_PASSWORD
        echo ""
        export ANSIBLE_USER
        export ANSIBLE_PASSWORD
        
        print_heading "SSH KEY FOR ANSIBLE USER"
        echo "1) Use existing SSH key file"
        echo "2) Paste SSH private key directly"
        echo "3) Generate new SSH key"
        read -rp "Choose option (1/2/3): " SSH_KEY_OPTION
        
        if [ "$SSH_KEY_OPTION" = "1" ]; then
            # Use existing SSH key file
            read -rp "Path to the ansible user's private key: " ANSIBLE_KEY_PATH
            if [ ! -f "$ANSIBLE_KEY_PATH" ]; then
                print_warning "Private key not found at $ANSIBLE_KEY_PATH. Please check the path and try again."
                exit 1
            fi
            
            print_success "Copying key to ~/.ssh/ansible_key"
            mkdir -p ~/.ssh
            cp "$ANSIBLE_KEY_PATH" ~/.ssh/ansible_key
            chmod 600 ~/.ssh/ansible_key
        elif [ "$SSH_KEY_OPTION" = "2" ]; then
            # Paste SSH key directly
            print_warning "Please paste your SSH private key for the ansible user (end with a new line followed by EOF):"
            
            mkdir -p ~/.ssh
            rm -f ~/.ssh/ansible_key
            
            while IFS= read -r line; do
                [[ "$line" == "EOF" ]] && break
                echo "$line" >> ~/.ssh/ansible_key
            done
            
            chmod 600 ~/.ssh/ansible_key
            print_success "SSH key saved to ~/.ssh/ansible_key"
        else
            generate_ansible_ssh_key
        fi
        
        ANSIBLE_USER_NEEDS_SETUP=false
    fi

    print_heading "CONFIGURATION SUMMARY"
    echo "Remote server: $SERVER_IP:$SSH_PORT"
    echo "Remote user: $REMOTE_USER"
    echo "Authentication method: $AUTH_METHOD"
    echo "Ansible user: $ANSIBLE_USER"
    if [ "$ANSIBLE_USER_NEEDS_SETUP" = true ]; then
        echo "Ansible user will be created: Yes"
    else
        echo "Using existing Ansible user: Yes"
    fi

    read -rp "Do you want to proceed with this configuration? (y/n) [default: y]: " PROCEED
    PROCEED=${PROCEED:-y}

    if [ "$PROCEED" != "y" ] && [ "$PROCEED" != "Y" ]; then
        print_warning "Setup aborted by user."
        exit 0
    fi

    if [ "$ANSIBLE_USER_NEEDS_SETUP" = true ]; then
        create_ansible_user_on_remote
    fi

    configure_services
    run_ansible_playbook
    display_completion
}

export -f setup_machine
