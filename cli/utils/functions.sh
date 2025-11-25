#!/bin/bash

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Safe tput wrapper that handles missing TERM variable
safe_tput() {
    if [ -n "${TERM:-}" ] && command -v tput >/dev/null 2>&1; then
        tput "$@" 2>/dev/null || true
    fi
}

cleanup() {
    echo -e "\n\n${YELLOW}Script interrupted by user. Goodbye!${NC}"
    safe_tput cnorm  # Show cursor
    jobs -p | xargs -r kill
    exit 1
}

print_heading() {
    echo -e "\n${BLUE}== $1 ==${NC}"
}

print_success() {
    echo -e "${GREEN}$1${NC}"
}

print_warning() {
    echo -e "${YELLOW}$1${NC}"
}

print_info() {
    echo -e "${CYAN}$1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_step() {
    echo -e "${BLUE}➜ $1${NC}"
}

print_tip() {
    echo -e "${YELLOW}💡 Tip: $1${NC}"
}

# Interactive menu with arrow key navigation
# Usage: interactive_menu "Prompt text" "Option 1" "Option 2" "Option 3" ...
# Returns: Selected index (0-based)
interactive_menu() {
    local prompt="$1"
    shift
    local options=("$@")
    local selected=0
    local num_options=${#options[@]}
    local lines_drawn=0
    
    # Hide cursor
    safe_tput civis
    
    # Function to draw menu
    draw_menu() {
        # Count lines as we draw
        lines_drawn=0
        
        echo -e "${CYAN}${prompt}${NC}"
        lines_drawn=$((lines_drawn + 1))
        
        echo ""
        lines_drawn=$((lines_drawn + 1))
        
        for i in "${!options[@]}"; do
            if [ "$i" -eq "$selected" ]; then
                echo -e "  ${GREEN}▸ ${options[$i]}${NC}"
            else
                echo -e "    ${options[$i]}"
            fi
            lines_drawn=$((lines_drawn + 1))
        done
        
        echo ""
        lines_drawn=$((lines_drawn + 1))
        
        echo -e "${YELLOW}Navigation: ↑↓ arrows to move, Enter to select, 'q' to quit${NC}"
        lines_drawn=$((lines_drawn + 1))
    }
    
    # Initial draw
    draw_menu
    
    # Read arrow keys
    while true; do
        # Read a single character
        IFS= read -rsn1 key
        
        # Handle different key codes
        case "$key" in
            $'\x1b')  # ESC sequence
                read -rsn2 -t 0.1 key  # Read the rest of the escape sequence
                case "$key" in
                    '[A')  # Up arrow
                        selected=$((selected - 1))
                        if [ "$selected" -lt 0 ]; then
                            selected=$((num_options - 1))
                        fi
                        ;;
                    '[B')  # Down arrow
                        selected=$((selected + 1))
                        if [ "$selected" -ge "$num_options" ]; then
                            selected=0
                        fi
                        ;;
                esac
                ;;
            '')  # Enter key
                # Show cursor
                safe_tput cnorm
                echo ""
                return $selected
                ;;
            'q'|'Q')  # Quit
                safe_tput cnorm
                echo ""
                echo ""
                print_warning "Exiting CLI..."
                exit 0
                ;;
        esac
        
        # Clear previous menu
        safe_tput cuu $lines_drawn
        safe_tput ed
        
        # Redraw menu
        draw_menu
    done
}

# Prompt for sudo password and validate it
# Usage: prompt_and_validate_sudo_password
# Sets: BECOME_PASSWORD (global variable)
# Returns: 0 on success, exits on failure
prompt_and_validate_sudo_password() {
    local CURRENT_USER
    CURRENT_USER=$(whoami)
    
    # Check if user is already root
    if [ "$EUID" -eq 0 ] || [ "$(id -u)" -eq 0 ]; then
        export BECOME_PASSWORD=""
        return 0
    fi
    
    # Check if user can sudo without password
    if sudo -n true 2>/dev/null; then
        export BECOME_PASSWORD=""
        return 0
    fi
    
    # User needs to provide password
    local SUDO_PASSWORD_VALID=false
    local SUDO_ATTEMPTS=0
    local MAX_SUDO_ATTEMPTS=3
    
    echo ""
    
    while [ "$SUDO_PASSWORD_VALID" = false ] && [ $SUDO_ATTEMPTS -lt $MAX_SUDO_ATTEMPTS ]; do
        echo -ne "${CYAN}Enter sudo password for user ${BLUE}$CURRENT_USER${CYAN}: ${NC}"
        read -rs BECOME_PASSWORD
        echo ""
        
        # Test if the password is correct
        if echo "$BECOME_PASSWORD" | sudo -S -v 2>/dev/null; then
            SUDO_PASSWORD_VALID=true
            print_success "Password verified successfully"
            export BECOME_PASSWORD
            return 0
        else
            SUDO_ATTEMPTS=$((SUDO_ATTEMPTS + 1))
            if [ "$SUDO_ATTEMPTS" -lt "$MAX_SUDO_ATTEMPTS" ]; then
                print_warning "Incorrect password. Please try again. (Attempt $SUDO_ATTEMPTS/$MAX_SUDO_ATTEMPTS)"
            else
                print_error "Maximum password attempts reached. Setup aborted."
                exit 1
            fi
        fi
    done
}

# Verify user password
# Usage: verify_user_password "username" "password"
# Returns: 0 if password is valid, 1 if invalid
verify_user_password() {
    local username="$1"
    local password="$2"
    
    if [ -z "$username" ] || [ -z "$password" ]; then
        return 1
    fi
    
    # If running as root, run the verification as the target user to avoid su bypass
    if [ "$(id -u)" -eq 0 ]; then
        # Run the su command as the target user (forces password check)
        sudo -u "$username" bash -c "echo '$password' | /bin/su --command true - '$username' 2>/dev/null"
        return $?
    else
        # Not root, use su directly
        echo "$password" | /bin/su --command true - "$username" 2>/dev/null
        return $?
    fi
}

# Prompt and validate user password
# Usage: prompt_and_validate_user_password "username" [variable_name]
# Sets: The specified variable name (default: USER_PASSWORD)
# Returns: 0 on success
prompt_and_validate_user_password() {
    local username="$1"
    local var_name="${2:-USER_PASSWORD}"
    local user_password=""
    
    if [ -z "$username" ]; then
        print_error "Username is required"
        return 1
    fi
    
    while true; do
        echo ""
        read -srp "Password for user $username: " user_password
        echo ""
        
        # Validate password is not empty
        if [ -z "$user_password" ]; then
            print_warning "Password cannot be empty. Please try again."
            continue
        fi
        
        # Verify password using sudo
        print_step "Verifying password..."
        if verify_user_password "$username" "$user_password"; then
            print_success "Password verified successfully"
            printf -v "$var_name" '%s' "$user_password"
            return 0
        else
            print_warning "Invalid password. Please try again."
        fi
    done
}

# Detect public IP address
detect_public_ip() {
    # Try to get public IP from external services
    local public_ip=""
    
    if command -v curl >/dev/null 2>&1; then
        public_ip=$(curl -s --connect-timeout 2 https://ifconfig.me 2>/dev/null || \
                   curl -s --connect-timeout 2 https://api.ipify.org 2>/dev/null || \
                   curl -s --connect-timeout 2 https://icanhazip.com 2>/dev/null)
    elif command -v wget >/dev/null 2>&1; then
        public_ip=$(wget -qO- --timeout=2 https://ifconfig.me 2>/dev/null || \
                   wget -qO- --timeout=2 https://api.ipify.org 2>/dev/null || \
                   wget -qO- --timeout=2 https://icanhazip.com 2>/dev/null)
    fi
    
    # Validate the IP
    if [[ -n "$public_ip" ]] && [[ "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$public_ip"
        return 0
    fi
    
    # Fallback to first non-loopback interface IP
    if command -v hostname >/dev/null 2>&1; then
        local local_ip
        local_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
        if [[ -n "$local_ip" ]]; then
            echo "$local_ip"
            return 0
        fi
    fi
    
    # Final fallback
    echo "127.0.0.1"
    return 0
}

# Detect SSH port
detect_ssh_port() {
    local default_port="22"
    
    # Check SSH config file
    if [ -f /etc/ssh/sshd_config ]; then
        local config_port
        config_port=$(grep -E "^Port " /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
        if [[ -n "$config_port" ]] && [[ "$config_port" =~ ^[0-9]+$ ]]; then
            echo "$config_port"
            return 0
        fi
    fi
    
    # Alternatively, check which port sshd is listening on
    if command -v ss >/dev/null 2>&1; then
        local listening_port
        listening_port=$(ss -tlnp 2>/dev/null | grep sshd | grep -oP ':\K[0-9]+' | head -1)
        if [[ -n "$listening_port" ]] && [[ "$listening_port" =~ ^[0-9]+$ ]]; then
            echo "$listening_port"
            return 0
        fi
    fi
    
    echo "$default_port"
    return 0
}

export -f detect_public_ip
export -f detect_ssh_port

