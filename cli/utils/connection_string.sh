#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

source "$CLI_UTILS_DIR/functions.sh"

# Generate connection string from parameters
# Args:
#   $1 - DOCKFLOW_HOST (IP or hostname)
#   $2 - PORT
#   $3 - DOCKFLOW_USER
#   $4 - PRIVATE_KEY
#   $5 - DOCKFLOW_PASSWORD (optional)
generate_connection_string() {
    local DOCKFLOW_HOST="$1"
    local PORT="$2"
    local DOCKFLOW_USER="$3"
    local PRIVATE_KEY="$4"
    local DOCKFLOW_PASSWORD="$5"

    if [ -z "$DOCKFLOW_HOST" ] || [ -z "$PORT" ] || [ -z "$DOCKFLOW_USER" ] || [ -z "$PRIVATE_KEY" ]; then
        echo "[Error: Missing required parameters for connection string]"
        return 1
    fi
    
    # Escape private key for JSON (replace newlines with \n)
    local ESCAPED_KEY=$(echo "$PRIVATE_KEY" | sed ':a;N;$!ba;s/\n/\\n/g' | sed 's/"/\\"/g')
    
    # Escape password for JSON
    local ESCAPED_PASSWORD=$(echo "$DOCKFLOW_PASSWORD" | sed 's/"/\\"/g')
    
    # Create JSON with connection info (including password if provided)
    if [ -n "$DOCKFLOW_PASSWORD" ]; then
        local JSON="{\"host\":\"$DOCKFLOW_HOST\",\"port\":$PORT,\"user\":\"$DOCKFLOW_USER\",\"privateKey\":\"$ESCAPED_KEY\",\"password\":\"$ESCAPED_PASSWORD\"}"
    else
        local JSON="{\"host\":\"$DOCKFLOW_HOST\",\"port\":$PORT,\"user\":\"$DOCKFLOW_USER\",\"privateKey\":\"$ESCAPED_KEY\"}"
    fi

    # Encode to base64
    local CONNECTION_STRING=$(echo -n "$JSON" | base64 -w 0 2>/dev/null || echo -n "$JSON" | base64)
    
    echo "$CONNECTION_STRING"
}

# Display connection information including private key and connection string
# Parameters:
#   $1 - DOCKFLOW_HOST (IP or hostname)
#   $2 - PORT (SSH port)
#   $3 - DOCKFLOW_USER (deployment user)
#   $4 - PRIVATE_KEY (SSH private key content)
#   $5 - DOCKFLOW_PASSWORD (optional)
display_connection_info() {
    local DOCKFLOW_HOST="$1"
    local PORT="$2"
    local DOCKFLOW_USER="$3"
    local PRIVATE_KEY="$4"
    local DOCKFLOW_PASSWORD="$5"
    
    # Display private key
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}SSH Private Key for deployment user $DOCKFLOW_USER (KEEP SECURE):${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo "$PRIVATE_KEY"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    # Generate connection string
    local CONNECTION_STRING=$(generate_connection_string "$DOCKFLOW_HOST" "$PORT" "$DOCKFLOW_USER" "$PRIVATE_KEY" "$DOCKFLOW_PASSWORD")
    
    if [ $? -eq 0 ] && [ -n "$CONNECTION_STRING" ]; then
        echo -e "${RED}╔═══════════════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║                        ⚠️  DO NOT SHARE  ⚠️                             ║${NC}"
        echo -e "${RED}║                                                                       ║${NC}"
        echo -e "${RED}║  This connection string contains the SSH private key!                 ║${NC}"
        echo -e "${RED}║  Anyone with this string can access your server as user: $DOCKFLOW_USER$(printf '%*s' $((7 - ${#DOCKFLOW_USER})) '')    ║${NC}"
        echo -e "${RED}╚═══════════════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${CYAN}Connection String (Base64 encoded):${NC}"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo "$CONNECTION_STRING"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "${CYAN}Deployment User:${NC} ${BLUE}$DOCKFLOW_USER${NC}"
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
    local DOCKFLOW_HOST="${1:-${SERVER_IP:-127.0.0.1}}"
    local PORT="${2:-${SSH_PORT:-22}}"
    local DOCKFLOW_USER="${3:-${DOCKFLOW_USER}}"
    local DOCKFLOW_PASSWORD_PARAM="${4:-}"
    
    if [ -z "$DOCKFLOW_USER" ]; then
        echo -e "${RED}[Error: DOCKFLOW_USER not defined]${NC}"
        return 1
    fi
    
    # Prompt for password if not provided
    local DOCKFLOW_PASSWORD_LOCAL=""
    if [ -z "$DOCKFLOW_PASSWORD_PARAM" ]; then
        # Verify password against the system
        prompt_and_validate_user_password "$DOCKFLOW_USER" "DOCKFLOW_PASSWORD_LOCAL"
        echo ""
    else
        DOCKFLOW_PASSWORD_LOCAL="$DOCKFLOW_PASSWORD_PARAM"
    fi
    
    # Retrieve the private key from deployment user's home (local only)
    local PRIVATE_KEY=""
    
    # Let the system prompt for sudo password if necessary
    if [ "$DOCKFLOW_USER" != "$(whoami)" ]; then
        PRIVATE_KEY=$(sudo cat "/home/$DOCKFLOW_USER/.ssh/dockflow_key" 2>/dev/null)
    else
        PRIVATE_KEY=$(cat "$HOME/.ssh/dockflow_key" 2>/dev/null)
    fi
    
    if [ -z "$PRIVATE_KEY" ]; then
        echo -e "${RED}[Error: Could not retrieve private key from /home/$DOCKFLOW_USER/.ssh/dockflow_key]${NC}"
        return 1
    fi
    
    # Display connection information
    display_connection_info "$DOCKFLOW_HOST" "$PORT" "$DOCKFLOW_USER" "$PRIVATE_KEY" "$DOCKFLOW_PASSWORD_LOCAL"
}
