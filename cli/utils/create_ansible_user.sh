#!/bin/bash

source "$(dirname "$0")/functions.sh"

setup_ansible_user() {
    print_heading "ANSIBLE USER SETUP"
    
    read -rp "Ansible user name [default: ansible]: " ANSIBLE_USER
    ANSIBLE_USER=${ANSIBLE_USER:-ansible}
    read -srp "Password for ansible user: " ANSIBLE_PASSWORD
    echo ""
    
    export ANSIBLE_USER
    export ANSIBLE_PASSWORD
}

create_ansible_user_on_remote() {
    # Create temporary script for remote execution
    TEMP_SCRIPT=$(mktemp)
    cat > "$TEMP_SCRIPT" << EOF
#!/bin/bash

# Create ansible user
echo "Creating ansible user..."
useradd -m $ANSIBLE_USER

# Add user to sudo group
echo "Adding $ANSIBLE_USER to sudo group..."
adduser $ANSIBLE_USER sudo

# Set password for ansible user
echo "Setting password for $ANSIBLE_USER..."
echo "$ANSIBLE_USER:$ANSIBLE_PASSWORD" | chpasswd

# Setup SSH directory
echo "Setting up SSH directory..."
mkdir -p /home/$ANSIBLE_USER/.ssh
chmod 700 /home/$ANSIBLE_USER/.ssh

# Add public key to authorized_keys
echo "Adding public key to authorized_keys..."
echo "$ANSIBLE_PUBLIC_KEY" | tee /home/$ANSIBLE_USER/.ssh/authorized_keys > /dev/null
chmod 600 /home/$ANSIBLE_USER/.ssh/authorized_keys

# Set proper ownership
echo "Setting proper ownership..."
chown -R $ANSIBLE_USER:$ANSIBLE_USER /home/$ANSIBLE_USER/.ssh

echo "User $ANSIBLE_USER has been created successfully."
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
