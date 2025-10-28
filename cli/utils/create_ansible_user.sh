#!/bin/bash

source "$CLI_UTILS_DIR/functions.sh"

setup_ansible_user() {
    print_heading "USER SETUP"
    
    echo -e "${CYAN}Configure the deployment user account:${NC}"
    echo ""
    
    prompt_username "User name" USER "dockflow"
    
    read -srp "Password for user: " USER_PASSWORD
    echo ""
    
    export USER
    export USER_PASSWORD
}

create_ansible_user_on_remote() {
    # Create temporary script for remote execution
    TEMP_SCRIPT=$(mktemp)
    cat > "$TEMP_SCRIPT" << EOF
#!/bin/bash

# Create user
echo "Creating user..."
useradd -m $USER

# Add user to sudo group
echo "Adding $USER to sudo group..."
adduser $USER sudo

# Set password for user
echo "Setting password for $USER..."
echo "$USER:$USER_PASSWORD" | chpasswd

# Setup SSH directory
echo "Setting up SSH directory..."
mkdir -p /home/$USER/.ssh
chmod 700 /home/$USER/.ssh

# Add public key to authorized_keys
echo "Adding public key to authorized_keys..."
echo "$ANSIBLE_PUBLIC_KEY" | tee /home/$USER/.ssh/authorized_keys > /dev/null
chmod 600 /home/$USER/.ssh/authorized_keys

# Set proper ownership
echo "Setting proper ownership..."
chown -R $USER:$USER /home/$USER/.ssh

echo "User $USER has been created successfully."
EOF

    chmod +x "$TEMP_SCRIPT"

    # Execute remote commands based on authentication method
    print_heading "EXECUTING REMOTE SETUP"
    if [ "$AUTH_METHOD" = "password" ]; then
        # Using sshpass if available, otherwise using expect
        if command -v sshpass &> /dev/null; then
            echo "Using sshpass for password authentication..."
            SSHPASS="$REMOTE_PASSWORD" sshpass -e scp -P "$SSH_PORT" -o StrictHostKeyChecking=no "$TEMP_SCRIPT" "$REMOTE_USER@$SERVER_IP:/tmp/setup_ansible.sh"
            SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo bash /tmp/setup_ansible.sh && rm /tmp/setup_ansible.sh"
        else
            echo "sshpass is not installed. Using interactive SSH..."
            print_warning "You will be prompted for the password of $REMOTE_USER@$SERVER_IP"
            scp -P "$SSH_PORT" -o StrictHostKeyChecking=no "$TEMP_SCRIPT" "$REMOTE_USER@$SERVER_IP:/tmp/setup_ansible.sh"
            ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo bash /tmp/setup_ansible.sh && rm /tmp/setup_ansible.sh"
        fi
    else
        # Using SSH key authentication
        echo "Using SSH key authentication..."
        scp -P "$SSH_PORT" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no "$TEMP_SCRIPT" "$REMOTE_USER@$SERVER_IP:/tmp/setup_ansible.sh"
        ssh -p "$SSH_PORT" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "sudo bash /tmp/setup_ansible.sh && rm /tmp/setup_ansible.sh"
    fi

    rm "$TEMP_SCRIPT"
}
