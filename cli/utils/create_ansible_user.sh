#!/bin/bash
set -eo pipefail
IFS=$'\n\t'

source "$CLI_UTILS_DIR/functions.sh"

setup_ansible_user() {
    print_heading "USER SETUP"
    
    echo -e "${CYAN}Configure the deployment user account:${NC}"
    echo ""
    
    # Check if default user "dockflow" already exists on the target server
    DEFAULT_USER="dockflow"
    USER_EXISTS=false
    
    # Determine if we're setting up local or remote
    if [ "${SERVER_IP:-}" = "127.0.0.1" ] || [ "${SERVER_IP:-}" = "localhost" ]; then
        # Local setup - check if user exists locally
        if id "$DEFAULT_USER" &>/dev/null; then
            USER_EXISTS=true
        fi
    else
        # Remote setup - check if user exists on remote server
        if [ -n "${SERVER_IP:-}" ] && [ -n "${REMOTE_USER:-}" ]; then
            if [ "${AUTH_METHOD:-}" = "password" ]; then
                if command -v sshpass &> /dev/null && [ -n "${REMOTE_PASSWORD:-}" ]; then
                    REMOTE_USER_CHECK=$(SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh -p "${SSH_PORT:-22}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "id $DEFAULT_USER && echo 'EXISTS' || echo 'NOTFOUND'" 2>/dev/null)
                    if echo "$REMOTE_USER_CHECK" | grep -q "EXISTS"; then
                        USER_EXISTS=true
                    fi
                fi
            elif [ -n "${SSH_PRIVATE_KEY_PATH:-}" ]; then
                REMOTE_USER_CHECK=$(ssh -p "${SSH_PORT:-22}" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "id $DEFAULT_USER && echo 'EXISTS' || echo 'NOTFOUND'" 2>/dev/null)
                if echo "$REMOTE_USER_CHECK" | grep -q "EXISTS"; then
                    USER_EXISTS=true
                fi
            fi
        fi
    fi
    
    # If user exists, ask if we should use it or create a new one
    if [ "$USER_EXISTS" = true ]; then
        echo ""
        print_step "User '$DEFAULT_USER' already exists on the target server"
        echo ""
        
        if confirm_action "Do you want to use the existing user '$DEFAULT_USER'?" "y"; then
            DOCKFLOW_USER="$DEFAULT_USER"
            print_success "Using existing user '$DEFAULT_USER'"
        else
            echo ""
            prompt_username "Enter a new user name" DOCKFLOW_USER ""
            # Check if the new user also exists
            if [ "${SERVER_IP:-}" = "127.0.0.1" ] || [ "${SERVER_IP:-}" = "localhost" ]; then
                if id "$DOCKFLOW_USER" &>/dev/null; then
                    USER_EXISTS=true
                else
                    USER_EXISTS=false
                fi
            else
                if [ "${AUTH_METHOD:-}" = "password" ]; then
                    if command -v sshpass &> /dev/null && [ -n "${REMOTE_PASSWORD:-}" ]; then
                        REMOTE_USER_CHECK=$(SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh -p "${SSH_PORT:-22}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "id $DOCKFLOW_USER && echo 'EXISTS' || echo 'NOTFOUND'" 2>/dev/null)
                        if echo "$REMOTE_USER_CHECK" | grep -q "EXISTS"; then
                            USER_EXISTS=true
                        else
                            USER_EXISTS=false
                        fi
                    fi
                elif [ -n "${SSH_PRIVATE_KEY_PATH:-}" ]; then
                    REMOTE_USER_CHECK=$(ssh -p "${SSH_PORT:-22}" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "id $DOCKFLOW_USER && echo 'EXISTS' || echo 'NOTFOUND'" 2>/dev/null)
                    if echo "$REMOTE_USER_CHECK" | grep -q "EXISTS"; then
                        USER_EXISTS=true
                    else
                        USER_EXISTS=false
                    fi
                fi
            fi
        fi
    else
        # User doesn't exist, prompt for username with default
        prompt_username "User name" DOCKFLOW_USER "dockflow"
    fi
    
    # Prompt for password with validation
    if [ "$USER_EXISTS" = true ]; then
        # User exists - verify the password is correct
        prompt_and_validate_user_password "$DOCKFLOW_USER" "DOCKFLOW_PASSWORD"
    else
        # New user - double confirmation
        while true; do
            read -srp "Password for new user $DOCKFLOW_USER: " DOCKFLOW_PASSWORD
            echo ""
            
            # Validate password is not empty
            if [ -z "$DOCKFLOW_PASSWORD" ]; then
                print_warning "Password cannot be empty. Please try again."
                echo ""
                continue
            fi
            
            # Confirm password
            read -srp "Confirm password: " DOCKFLOW_PASSWORD_CONFIRM
            echo ""
            
            # Check if passwords match
            if [ "$DOCKFLOW_PASSWORD" = "$DOCKFLOW_PASSWORD_CONFIRM" ]; then
                print_success "Password confirmed"
                break
            else
                print_warning "Passwords do not match. Please try again."
                echo ""
            fi
        done
    fi
    
    export DOCKFLOW_USER
    export DOCKFLOW_PASSWORD
}

# Generate the user creation script
# This script will be executed either locally or remotely
generate_user_creation_script() {
    cat << 'EOF'
#!/bin/bash

# Create user
echo "Creating user..."
useradd -m $DOCKFLOW_USER 2>/dev/null || echo "User $DOCKFLOW_USER may already exist, continuing..."

# Set password for user if provided
if [ -n "$DOCKFLOW_PASSWORD" ]; then
    echo "Setting password for $DOCKFLOW_USER..."
    echo "$DOCKFLOW_USER:$DOCKFLOW_PASSWORD" | chpasswd
fi

# Add user to sudo group
echo "Adding $DOCKFLOW_USER to sudo group..."
usermod -aG sudo $DOCKFLOW_USER 2>/dev/null || adduser $DOCKFLOW_USER sudo 2>/dev/null

# Add user to docker group
echo "Adding $DOCKFLOW_USER to docker group..."
usermod -aG docker $DOCKFLOW_USER 2>/dev/null || echo "Docker group will be created later..."

# Setup SSH directory
echo "Setting up SSH directory..."
mkdir -p /home/$DOCKFLOW_USER/.ssh
chmod 700 /home/$DOCKFLOW_USER/.ssh

# Add public key to authorized_keys
echo "Adding public key to authorized_keys..."
echo "$ANSIBLE_PUBLIC_KEY" > /home/$DOCKFLOW_USER/.ssh/authorized_keys
chmod 600 /home/$DOCKFLOW_USER/.ssh/authorized_keys

# Save private key for the deployment user
if [ -n "$ANSIBLE_PRIVATE_KEY" ]; then
    echo "Saving private key to /home/$DOCKFLOW_USER/.ssh/dockflow_key..."
    echo "$ANSIBLE_PRIVATE_KEY" > /home/$DOCKFLOW_USER/.ssh/dockflow_key
    chmod 600 /home/$DOCKFLOW_USER/.ssh/dockflow_key
    echo "$ANSIBLE_PUBLIC_KEY" > /home/$DOCKFLOW_USER/.ssh/dockflow_key.pub
    chmod 644 /home/$DOCKFLOW_USER/.ssh/dockflow_key.pub
fi

# Set proper ownership
echo "Setting proper ownership..."
chown -R $DOCKFLOW_USER:$DOCKFLOW_USER /home/$DOCKFLOW_USER/.ssh

echo "User $DOCKFLOW_USER has been configured successfully."
EOF
}

create_ansible_user_on_remote() {
    if [ "${IS_LOCAL_RUN:-false}" = "true" ]; then
        create_ansible_user_locally
        return
    fi

    print_heading "EXECUTING REMOTE SETUP"
    
    # Create temporary script for remote execution
    TEMP_SCRIPT=$(mktemp)
    generate_user_creation_script > "$TEMP_SCRIPT"
    chmod +x "$TEMP_SCRIPT"

    # Execute remote commands based on authentication method
    if [ "$AUTH_METHOD" = "password" ]; then
        # Using sshpass if available, otherwise using expect
        if command -v sshpass &> /dev/null; then
            echo "Using sshpass for password authentication..."
            SSHPASS="$REMOTE_PASSWORD" sshpass -e scp -P "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$TEMP_SCRIPT" "$REMOTE_USER@$SERVER_IP:/tmp/setup_ansible.sh"
            SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "DOCKFLOW_USER='$DOCKFLOW_USER' DOCKFLOW_PASSWORD='$DOCKFLOW_PASSWORD' ANSIBLE_PUBLIC_KEY='$ANSIBLE_PUBLIC_KEY' ANSIBLE_PRIVATE_KEY='$ANSIBLE_PRIVATE_KEY' sudo -E bash /tmp/setup_ansible.sh && rm /tmp/setup_ansible.sh"
        else
            echo "sshpass is not installed. Using interactive SSH..."
            print_warning "You will be prompted for the password of $REMOTE_USER@$SERVER_IP"
            scp -P "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$TEMP_SCRIPT" "$REMOTE_USER@$SERVER_IP:/tmp/setup_ansible.sh"
            ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "DOCKFLOW_USER='$DOCKFLOW_USER' DOCKFLOW_PASSWORD='$DOCKFLOW_PASSWORD' ANSIBLE_PUBLIC_KEY='$ANSIBLE_PUBLIC_KEY' ANSIBLE_PRIVATE_KEY='$ANSIBLE_PRIVATE_KEY' sudo -E bash /tmp/setup_ansible.sh && rm /tmp/setup_ansible.sh"
        fi
    else
        # Using SSH key authentication
        echo "Using SSH key authentication..."
        scp -P "$SSH_PORT" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$TEMP_SCRIPT" "$REMOTE_USER@$SERVER_IP:/tmp/setup_ansible.sh"
        ssh -p "$SSH_PORT" -i "$SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$REMOTE_USER@$SERVER_IP" "DOCKFLOW_USER='$DOCKFLOW_USER' DOCKFLOW_PASSWORD='$DOCKFLOW_PASSWORD' ANSIBLE_PUBLIC_KEY='$ANSIBLE_PUBLIC_KEY' ANSIBLE_PRIVATE_KEY='$ANSIBLE_PRIVATE_KEY' sudo -E bash /tmp/setup_ansible.sh && rm /tmp/setup_ansible.sh"
    fi

    rm "$TEMP_SCRIPT"
    
    # Copy the private key locally to ~/.ssh/deploy_key for CLI use
    if [ -n "${ANSIBLE_PRIVATE_KEY:-}" ]; then
        mkdir -p ~/.ssh
        echo "$ANSIBLE_PRIVATE_KEY" > ~/.ssh/deploy_key
        chmod 600 ~/.ssh/deploy_key
    fi
}

create_ansible_user_locally() {
    print_heading "CREATING DEPLOYMENT USER LOCALLY"
    
    echo "Creating user $DOCKFLOW_USER on local machine..."
    
    # Create temporary script for local execution
    TEMP_SCRIPT=$(mktemp)
    generate_user_creation_script > "$TEMP_SCRIPT"
    chmod +x "$TEMP_SCRIPT"
    
    # Execute locally with sudo
    DOCKFLOW_USER="$DOCKFLOW_USER" \
    DOCKFLOW_PASSWORD="$DOCKFLOW_PASSWORD" \
    ANSIBLE_PUBLIC_KEY="$ANSIBLE_PUBLIC_KEY" \
    ANSIBLE_PRIVATE_KEY="$ANSIBLE_PRIVATE_KEY" \
    sudo -E bash "$TEMP_SCRIPT"
    
    rm "$TEMP_SCRIPT"
    
    # Copy the private key locally to ~/.ssh/deploy_key for CLI use
    if [ -n "${ANSIBLE_PRIVATE_KEY:-}" ]; then
        mkdir -p ~/.ssh
        echo "$ANSIBLE_PRIVATE_KEY" > ~/.ssh/deploy_key
        chmod 600 ~/.ssh/deploy_key
    fi
    
    print_success "User $DOCKFLOW_USER has been created successfully on local machine."
}
