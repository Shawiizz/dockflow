#!/bin/bash

source "$(dirname "$0")/functions.sh"

get_ssh_connection() {
    print_heading "CONNECTION METHOD"
    echo "1) Use password authentication"
    echo "2) Use SSH key authentication (file path)"
    echo "3) Use SSH key authentication (paste directly)"
    echo "4) Generate new SSH key pair"
    read -rp "Choose connection method (1/2/3/4): " CONNECTION_METHOD

    if [ "$CONNECTION_METHOD" = "1" ]; then
        # Password authentication
        read -rp "Remote server username: " REMOTE_USER
        read -srp "Remote server password: " REMOTE_PASSWORD
        echo ""
        AUTH_METHOD="password"
    elif [ "$CONNECTION_METHOD" = "2" ]; then
        # SSH key authentication from file
        read -rp "Remote server username: " REMOTE_USER
        read -rp "Path to your SSH private key [default: ~/.ssh/id_rsa]: " SSH_PRIVATE_KEY_PATH
        SSH_PRIVATE_KEY_PATH=${SSH_PRIVATE_KEY_PATH:-~/.ssh/id_rsa}
        
        if [ ! -f "$SSH_PRIVATE_KEY_PATH" ]; then
            print_warning "Error: SSH key not found at $SSH_PRIVATE_KEY_PATH"
            exit 1
        fi
        AUTH_METHOD="key"
    elif [ "$CONNECTION_METHOD" = "3" ]; then
        # SSH key authentication from direct input
        read -rp "Remote server username: " REMOTE_USER
        print_warning "Please paste your SSH private key (end with a new line followed by EOF):"
        
        # Create temporary directory and file for the key
        TEMP_KEY_DIR=$(mktemp -d)
        SSH_PRIVATE_KEY_PATH="$TEMP_KEY_DIR/id_ssh"
        
        while IFS= read -r line; do
            [[ "$line" == "EOF" ]] && break
            echo "$line" >> "$SSH_PRIVATE_KEY_PATH"
        done
        
        chmod 600 "$SSH_PRIVATE_KEY_PATH"
        print_success "SSH key saved temporarily."
        AUTH_METHOD="key"
    else
        # Generate new SSH key pair
        read -rp "Remote server username: " REMOTE_USER
        
        # Create directory for the new key
        TEMP_KEY_DIR=$(mktemp -d)
        SSH_PRIVATE_KEY_PATH="$TEMP_KEY_DIR/id_ssh"
        
        print_success "Generating new SSH key pair..."
        ssh-keygen -t ed25519 -f "$SSH_PRIVATE_KEY_PATH" -N "" -C "$REMOTE_USER-automation"
        
        echo -e "\n${YELLOW}Here's your new public key:${NC}"
        cat "${SSH_PRIVATE_KEY_PATH}.pub"
        echo -e "\n${YELLOW}You need to add this public key to ~/.ssh/authorized_keys on your remote server for $REMOTE_USER${NC}"
        echo -e "${YELLOW}Example command to run on the remote server:${NC}"
        echo "mkdir -p ~/.ssh && echo '$(cat ${SSH_PRIVATE_KEY_PATH}.pub)' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
        
        read -rp "Press Enter when the public key has been added to the remote server to continue..." CONTINUE_KEY
        
        chmod 600 "$SSH_PRIVATE_KEY_PATH"
        AUTH_METHOD="key"
    fi

    export REMOTE_USER
    export REMOTE_PASSWORD
    export SSH_PRIVATE_KEY_PATH
    export AUTH_METHOD
}

generate_ansible_ssh_key() {
    print_heading "ANSIBLE SSH KEY SETUP"
    read -rp "Do you want to generate a new SSH key for the ansible user? (y/n) [default: y]: " GENERATE_ANSIBLE_KEY
    GENERATE_ANSIBLE_KEY=${GENERATE_ANSIBLE_KEY:-y}

    if [ "$GENERATE_ANSIBLE_KEY" = "y" ] || [ "$GENERATE_ANSIBLE_KEY" = "Y" ]; then
        TEMP_KEY_DIR=$(mktemp -d)
        ssh-keygen -t ed25519 -f "$TEMP_KEY_DIR/ansible_key" -N "" -C "ansible-automation"
        ANSIBLE_PUBLIC_KEY=$(cat "$TEMP_KEY_DIR/ansible_key.pub")
        ANSIBLE_PRIVATE_KEY=$(cat "$TEMP_KEY_DIR/ansible_key")
        
        print_success "SSH key pair generated for ansible user"
        echo -e "${YELLOW}Public key:${NC} $ANSIBLE_PUBLIC_KEY"
        
        print_success "Saving private key to ~/.ssh/ansible_key"
        mkdir -p ~/.ssh
        echo "$ANSIBLE_PRIVATE_KEY" > ~/.ssh/ansible_key
        chmod 600 ~/.ssh/ansible_key
        print_success "Private key saved to ~/.ssh/ansible_key"
        
        rm -rf "$TEMP_KEY_DIR"
    else
        # Ask for existing key
        read -rp "Path to the ansible user's private key: " ANSIBLE_PRIVATE_KEY_PATH
        if [ ! -f "$ANSIBLE_PRIVATE_KEY_PATH" ]; then
            print_warning "Private key not found at $ANSIBLE_PRIVATE_KEY_PATH"
            exit 1
        fi
        
        read -rp "Path to the ansible user's public key: " ANSIBLE_PUBLIC_KEY_PATH
        if [ ! -f "$ANSIBLE_PUBLIC_KEY_PATH" ]; then
            print_warning "Public key not found at $ANSIBLE_PUBLIC_KEY_PATH"
            exit 1
        fi
        
        ANSIBLE_PUBLIC_KEY=$(cat "$ANSIBLE_PUBLIC_KEY_PATH")
        
        print_success "Copying private key to ~/.ssh/ansible_key"
        mkdir -p ~/.ssh
        cp "$ANSIBLE_PRIVATE_KEY_PATH" ~/.ssh/ansible_key
        chmod 600 ~/.ssh/ansible_key
    fi

    export ANSIBLE_PUBLIC_KEY
}

CLI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
