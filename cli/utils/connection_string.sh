#!/bin/bash

source "$CLI_UTILS_DIR/functions.sh"

# Generate a connection string (base64 encoded JSON) containing connection details
# Parameters:
#   $1 - HOST (IP or hostname)
#   $2 - PORT (SSH port)
#   $3 - USER (deployment user)
#   $4 - PRIVATE_KEY (SSH private key content)
generate_connection_string() {
    local HOST="$1"
    local PORT="$2"
    local USER="$3"
    local PRIVATE_KEY="$4"
    
    if [ -z "$HOST" ] || [ -z "$PORT" ] || [ -z "$USER" ] || [ -z "$PRIVATE_KEY" ]; then
        echo "[Error: Missing required parameters for connection string]"
        return 1
    fi
    
    # Escape private key for JSON (replace newlines with \n)
    local ESCAPED_KEY=$(echo "$PRIVATE_KEY" | sed ':a;N;$!ba;s/\n/\\n/g' | sed 's/"/\\"/g')
    
    # Create JSON object
    local JSON="{\"host\":\"$HOST\",\"port\":$PORT,\"user\":\"$USER\",\"privateKey\":\"$ESCAPED_KEY\"}"
    
    # Encode to base64
    local CONNECTION_STRING=$(echo -n "$JSON" | base64 -w 0 2>/dev/null || echo -n "$JSON" | base64)
    
    echo "$CONNECTION_STRING"
}

# Display connection information including private key and connection string
# Parameters:
#   $1 - HOST (IP or hostname)
#   $2 - PORT (SSH port)
#   $3 - USER (deployment user)
#   $4 - PRIVATE_KEY (SSH private key content)
display_connection_info() {
    local HOST="$1"
    local PORT="$2"
    local USER="$3"
    local PRIVATE_KEY="$4"
    
    # Display private key
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}SSH Private Key for deployment user $USER (KEEP SECURE):${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo "$PRIVATE_KEY"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    # Generate connection string
    local CONNECTION_STRING=$(generate_connection_string "$HOST" "$PORT" "$USER" "$PRIVATE_KEY")
    
    if [ $? -eq 0 ] && [ -n "$CONNECTION_STRING" ]; then
        echo -e "${RED}╔═══════════════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║                        ⚠️  DO NOT SHARE  ⚠️                             ║${NC}"
        echo -e "${RED}║                                                                       ║${NC}"
        echo -e "${RED}║  This connection string contains the SSH private key!                 ║${NC}"
        echo -e "${RED}║  Anyone with this string can access your server as user: $USER$(printf '%*s' $((7 - ${#USER})) '')    ║${NC}"
        echo -e "${RED}╚═══════════════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${CYAN}Connection String (Base64 encoded):${NC}"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo "$CONNECTION_STRING"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "${CYAN}Deployment User:${NC} ${BLUE}$USER${NC}"
        echo ""
        echo -e "${YELLOW}💡 Add this connection string to your CI/CD secrets:${NC}"
        echo -e "   ${GRAY}Secret name: [YOURENV]_CONNECTION${NC}"
        echo -e "   ${GRAY}(Replace [YOURENV] by your real environment name, e.g. PRODUCTION_CONNECTION)${NC}"
        echo -e "   ${GRAY}This allows the deployment system to connect to your server${NC}"
    else
        echo -e "${RED}[Error: Could not generate connection string]${NC}"
    fi
    echo ""
}

# Retrieve and display connection information for deployment user
# This function retrieves the private key and generates the connection string
# Works only for local retrieval
display_deployment_connection_info() {
    local HOST="${1:-${SERVER_IP:-127.0.0.1}}"
    local PORT="${2:-${SSH_PORT:-22}}"
    local USER="${3:-${USER}}"
    
    if [ -z "$USER" ]; then
        echo -e "${RED}[Error: USER not defined]${NC}"
        return 1
    fi
    
    # Retrieve the private key from deployment user's home (local only)
    local PRIVATE_KEY=""
    
    # Let the system prompt for sudo password if necessary
    if [ "$USER" != "$(whoami)" ]; then
        PRIVATE_KEY=$(sudo cat "/home/$USER/.ssh/dockflow_key" 2>/dev/null)
    else
        PRIVATE_KEY=$(cat "$HOME/.ssh/dockflow_key" 2>/dev/null)
    fi
    
    if [ -z "$PRIVATE_KEY" ]; then
        echo -e "${RED}[Error: Could not retrieve private key from /home/$USER/.ssh/dockflow_key]${NC}"
        return 1
    fi
    
    # Display connection information
    display_connection_info "$HOST" "$PORT" "$USER" "$PRIVATE_KEY"
}
