#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# ============================================
# VALIDATION UTILITIES
# ============================================
# This script provides validation functions
# for user inputs to ensure data integrity
# ============================================

# Validate IP address (IPv4)
validate_ip_address() {
    local ip="$1"
    
    # Regex that matches valid IP addresses (0-255 for each octet)
    # Matches: 0-9, 10-99, 100-199, 200-249, 250-255
    local octet='(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)'
    local ip_regex="^${octet}\.${octet}\.${octet}\.${octet}$"
    
    if [[ "$ip" =~ $ip_regex ]]; then
        return 0
    else
        return 1
    fi
}

# Validate hostname/domain name
validate_hostname() {
    local hostname="$1"
    
    # Reject if it looks like an IP address (all digits and dots)
    # This prevents invalid IPs like 999.999.999.999 from being accepted as hostnames
    if [[ "$hostname" =~ ^[0-9.]+$ ]]; then
        return 1
    fi
    
    local hostname_regex='^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$'
    
    if [[ ! "$hostname" =~ $hostname_regex ]]; then
        return 1
    fi
    
    return 0
}

# Validate IP or hostname
validate_host() {
    local host="$1"
    
    # Try IP first
    if validate_ip_address "$host"; then
        return 0
    fi
    
    # Try hostname
    if validate_hostname "$host"; then
        return 0
    fi
    
    return 1
}

# Validate port number
validate_port() {
    local port="$1"
    
    # Check if numeric
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    
    # Check range (1-65535)
    if ((port < 1 || port > 65535)); then
        return 1
    fi
    
    return 0
}

# Validate environment name
validate_env_name() {
    local env_name="$1"
    
    # Must be lowercase alphanumeric with hyphens, no spaces
    local env_regex='^[a-z0-9][a-z0-9\-]*[a-z0-9]$|^[a-z0-9]$'
    
    if [[ ! "$env_name" =~ $env_regex ]]; then
        return 1
    fi
    
    # Check length (min 2, max 50)
    local length=${#env_name}
    if ((length < 2 || length > 50)); then
        return 1
    fi
    
    # Cannot start or end with hyphen
    if [[ "$env_name" =~ ^- ]] || [[ "$env_name" =~ -$ ]]; then
        return 1
    fi
    
    return 0
}

# Validate username
validate_username() {
    local username="$1"
    
    # Must be alphanumeric with underscores/hyphens
    local user_regex='^[a-z_][a-z0-9_-]*$'
    
    if [[ ! "$username" =~ $user_regex ]]; then
        return 1
    fi
    
    # Check length (min 2, max 32)
    local length=${#username}
    if ((length < 2 || length > 32)); then
        return 1
    fi
    
    return 0
}

# Validate domain name (stricter than hostname)
validate_domain_name() {
    local domain="$1"
    
    # Must have at least one dot
    if [[ ! "$domain" =~ \. ]]; then
        return 1
    fi
    
    # Use hostname validation
    if ! validate_hostname "$domain"; then
        return 1
    fi
    
    return 0
}

# Prompt with validation loop
prompt_with_validation() {
    local prompt_text="$1"
    local validator_function="$2"
    local error_message="$3"
    local default_value="${4:-}"
    local var_name="$5"
    local is_secret="${6:-false}"
    
    while true; do
        if [ "$is_secret" = "true" ]; then
            read -srp "$prompt_text" input_value
            echo ""
        else
            read -rp "$prompt_text" input_value
        fi
        
        # Use default if empty and default is provided
        if [ -z "$input_value" ] && [ -n "$default_value" ]; then
            input_value="$default_value"
        fi
        
        # Skip validation if empty and no default (optional field)
        if [ -z "$input_value" ] && [ -z "$default_value" ]; then
                printf -v "$var_name" ''
            return 0
        fi
        
        # Validate
        if $validator_function "$input_value"; then
                printf -v "$var_name" '%s' "$input_value"
            return 0
        else
            print_warning "$error_message"
            echo ""
        fi
    done
}

# Prompt for IP address with validation
prompt_ip_address() {
    local prompt_text="$1"
    local var_name="$2"
    local default_value="${3:-}"
    
    local full_prompt="$prompt_text"
    if [ -n "$default_value" ]; then
        full_prompt="$prompt_text [default: $default_value]: "
    else
        full_prompt="$prompt_text: "
    fi
    
    prompt_with_validation \
        "$full_prompt" \
        "validate_ip_address" \
        "Invalid IP address. Format: XXX.XXX.XXX.XXX (e.g., 192.168.1.10)" \
        "$default_value" \
        "$var_name" \
        "false"
}

# Prompt for host (IP or hostname) with validation
prompt_host() {
    local prompt_text="$1"
    local var_name="$2"
    local default_value="${3:-}"
    
    local full_prompt="$prompt_text"
    if [ -n "$default_value" ]; then
        full_prompt="$prompt_text [default: $default_value]: "
    else
        full_prompt="$prompt_text: "
    fi
    
    prompt_with_validation \
        "$full_prompt" \
        "validate_host" \
        "Invalid host. Must be a valid IP address or hostname" \
        "$default_value" \
        "$var_name" \
        "false"
}

# Prompt for port with validation
prompt_port() {
    local prompt_text="$1"
    local var_name="$2"
    local default_value="${3:-}"
    
    local full_prompt="$prompt_text"
    if [ -n "$default_value" ]; then
        full_prompt="$prompt_text [default: $default_value]: "
    else
        full_prompt="$prompt_text: "
    fi
    
    prompt_with_validation \
        "$full_prompt" \
        "validate_port" \
        "Invalid port. Must be a number between 1 and 65535" \
        "$default_value" \
        "$var_name" \
        "false"
}

# Prompt for environment name with validation
prompt_env_name() {
    local prompt_text="$1"
    local var_name="$2"
    
    echo -e "${CYAN}Environment name rules:${NC}"
    echo "  • Lowercase letters, numbers, and hyphens only"
    echo "  • Must start and end with a letter or number"
    echo "  • Between 2 and 50 characters"
    echo "  • Examples: production, staging, dev, test-env, qa-2024"
    echo ""
    
    prompt_with_validation \
        "$prompt_text: " \
        "validate_env_name" \
        "Invalid environment name. Must be lowercase alphanumeric with hyphens (2-50 chars)" \
        "" \
        "$var_name" \
        "false"
}

# Prompt for username with validation
prompt_username() {
    local prompt_text="$1"
    local var_name="$2"
    local default_value="${3:-}"
    
    local full_prompt="$prompt_text"
    if [ -n "$default_value" ]; then
        full_prompt="$prompt_text [default: $default_value]: "
    else
        full_prompt="$prompt_text: "
    fi
    
    prompt_with_validation \
        "$full_prompt" \
        "validate_username" \
        "Invalid username. Must be lowercase alphanumeric with underscores/hyphens (2-32 chars)" \
        "$default_value" \
        "$var_name" \
        "false"
}

# Prompt for domain name with validation
prompt_domain_name() {
    local prompt_text="$1"
    local var_name="$2"
    local allow_empty="${3:-false}"
    
    if [ "$allow_empty" = "true" ]; then
        read -rp "$prompt_text (optional): " input_value
        if [ -z "$input_value" ]; then
                printf -v "$var_name" ''
            return 0
        fi
    fi
    
    prompt_with_validation \
        "$prompt_text: " \
        "validate_domain_name" \
        "Invalid domain name. Format: example.com or subdomain.example.com" \
        "" \
        "$var_name" \
        "false"
}

# Confirm action (yes/no)
confirm_action() {
    local prompt_text="$1"
    local default="${2:-n}"
    
    local options
    if [ "$default" = "y" ]; then
        options="[Y/n]"
    else
        options="[y/N]"
    fi
    
    while true; do
        read -rp "$prompt_text $options: " response
        response=${response:-$default}
        
        case "${response,,}" in
            y|yes)
                return 0
                ;;
            n|no)
                return 1
                ;;
            *)
                print_warning "Please answer 'y' or 'n'"
                ;;
        esac
    done
}

export -f validate_ip_address
export -f validate_hostname
export -f validate_host
export -f validate_port
export -f validate_env_name
export -f validate_username
export -f validate_domain_name
export -f prompt_with_validation
export -f prompt_ip_address
export -f prompt_host
export -f prompt_port
export -f prompt_env_name
export -f prompt_username
export -f prompt_domain_name
export -f confirm_action
