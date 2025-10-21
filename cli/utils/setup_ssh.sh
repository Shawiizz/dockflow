#!/bin/bash

source "$CLI_UTILS_DIR/functions.sh"

list_and_select_ssh_key() {
    local ssh_dir="$HOME/.ssh"
    
    if [ ! -d "$ssh_dir" ]; then
        print_warning "SSH directory $ssh_dir not found"
        return 1
    fi
    
    # Find private key files (exclude .pub, known_hosts, config, etc.)
    local private_keys=()
    while IFS= read -r -d '' file; do
        # Check if it's likely a private key (not .pub, not known_hosts, not config)
        local basename=$(basename "$file")
        if [[ ! "$basename" =~ \.(pub|known_hosts|config)$ ]] && [[ "$basename" != "known_hosts" ]] && [[ "$basename" != "config" ]]; then
            # Additional check: private keys typically start with specific headers
            if head -1 "$file" 2>/dev/null | grep -q "BEGIN.*PRIVATE KEY\|BEGIN OPENSSH PRIVATE KEY\|BEGIN RSA PRIVATE KEY\|BEGIN DSA PRIVATE KEY\|BEGIN EC PRIVATE KEY"; then
                private_keys+=("$file")
            fi
        fi
    done < <(find "$ssh_dir" -type f -print0 2>/dev/null)
    
    if [ ${#private_keys[@]} -eq 0 ]; then
        print_warning "No private SSH keys found in $ssh_dir"
        return 1
    fi
    
    print_heading "AVAILABLE SSH PRIVATE KEYS"
    
    local options=()
    for key_file in "${private_keys[@]}"; do
        local key_name=$(basename "$key_file")
        options+=("$key_name ($(dirname "$key_file")/$key_name)")
    done
    
    interactive_menu "Select a private key:" "${options[@]}"
    local choice=$?
    
    SSH_PRIVATE_KEY_PATH="${private_keys[$choice]}"
    print_success "Selected: $(basename "$SSH_PRIVATE_KEY_PATH")"
    return 0
}

get_ssh_connection() {
    print_heading "CONNECTION METHOD"
    
    local options=(
        "Use password authentication"
        "Use SSH key authentication (select from available keys)"
        "Use SSH key authentication (paste directly)"
        "Generate new SSH key pair"
    )
    
    interactive_menu "Choose connection method:" "${options[@]}"
    CONNECTION_METHOD=$?

    if [ "$CONNECTION_METHOD" = "0" ]; then
        # Password authentication
        read -rp "Remote server username: " REMOTE_USER
        read -srp "Remote server password: " REMOTE_PASSWORD
        echo ""
        AUTH_METHOD="password"
    elif [ "$CONNECTION_METHOD" = "1" ]; then
        # SSH key authentication from file selection
        read -rp "Remote server username: " REMOTE_USER
        
        if ! list_and_select_ssh_key; then
            print_warning "No SSH key selected or available. Exiting..."
            exit 1
        fi
        
        if [ ! -f "$SSH_PRIVATE_KEY_PATH" ]; then
            print_warning "Error: SSH key not found at $SSH_PRIVATE_KEY_PATH"
            exit 1
        fi
        AUTH_METHOD="key"
    elif [ "$CONNECTION_METHOD" = "2" ]; then
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
        echo ""
        
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
        print_heading "SELECT EXISTING ANSIBLE PRIVATE KEY"
        if ! list_and_select_ssh_key; then
            print_warning "No SSH key selected or available. Exiting..."
            exit 1
        fi
        
        ANSIBLE_PRIVATE_KEY_PATH="$SSH_PRIVATE_KEY_PATH"
        
        if [ ! -f "$ANSIBLE_PRIVATE_KEY_PATH" ]; then
            print_warning "Private key not found at $ANSIBLE_PRIVATE_KEY_PATH"
            exit 1
        fi
        
        # Check if corresponding public key exists
        ANSIBLE_PUBLIC_KEY_PATH="${ANSIBLE_PRIVATE_KEY_PATH}.pub"
        if [ ! -f "$ANSIBLE_PUBLIC_KEY_PATH" ]; then
            print_warning "Public key not found at $ANSIBLE_PUBLIC_KEY_PATH"
            print_warning "Trying to generate public key from private key..."
            ssh-keygen -y -f "$ANSIBLE_PRIVATE_KEY_PATH" > "$ANSIBLE_PUBLIC_KEY_PATH" 2>/dev/null
            if [ $? -eq 0 ]; then
                print_success "Public key generated successfully"
            else
                print_warning "Failed to generate public key. Please ensure the private key is valid."
                exit 1
            fi
        fi
        
        ANSIBLE_PUBLIC_KEY=$(cat "$ANSIBLE_PUBLIC_KEY_PATH")
        
        print_success "Copying private key to ~/.ssh/ansible_key"
        mkdir -p ~/.ssh
        cp "$ANSIBLE_PRIVATE_KEY_PATH" ~/.ssh/ansible_key
        chmod 600 ~/.ssh/ansible_key
    fi

    export ANSIBLE_PUBLIC_KEY
}
