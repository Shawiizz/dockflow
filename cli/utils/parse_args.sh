#!/bin/bash

# ============================================
# ARGUMENT PARSING UTILITIES
# ============================================
# Parse command-line arguments for non-interactive mode
# ============================================

# Parse setup-machine arguments
parse_setup_machine_args() {
    # Reset all variables
    unset ARG_HOST ARG_PORT ARG_REMOTE_USER ARG_REMOTE_PASSWORD ARG_REMOTE_KEY
    unset ARG_DEPLOY_USER ARG_DEPLOY_PASSWORD ARG_DEPLOY_KEY ARG_GENERATE_KEY
    unset ARG_INSTALL_PORTAINER ARG_PORTAINER_PASSWORD ARG_PORTAINER_PORT ARG_PORTAINER_DOMAIN
    
    # Default values
    ARG_PORT="22"
    ARG_GENERATE_KEY="n"
    ARG_INSTALL_PORTAINER="n"
    ARG_PORTAINER_PORT="9000"
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --host)
                ARG_HOST="$2"
                shift 2
                ;;
            --port)
                ARG_PORT="$2"
                shift 2
                ;;
            --remote-user)
                ARG_REMOTE_USER="$2"
                shift 2
                ;;
            --remote-password)
                ARG_REMOTE_PASSWORD="$2"
                shift 2
                ;;
            --remote-key)
                ARG_REMOTE_KEY="$2"
                shift 2
                ;;
            --deploy-user)
                ARG_DEPLOY_USER="$2"
                shift 2
                ;;
            --deploy-password)
                ARG_DEPLOY_PASSWORD="$2"
                shift 2
                ;;
            --deploy-key)
                ARG_DEPLOY_KEY="$2"
                shift 2
                ;;
            --generate-key)
                ARG_GENERATE_KEY="$2"
                shift 2
                ;;
            --install-portainer)
                ARG_INSTALL_PORTAINER="$2"
                shift 2
                ;;
            --portainer-password)
                ARG_PORTAINER_PASSWORD="$2"
                shift 2
                ;;
            --portainer-port)
                ARG_PORTAINER_PORT="$2"
                shift 2
                ;;
            --portainer-domain)
                ARG_PORTAINER_DOMAIN="$2"
                shift 2
                ;;
            *)
                echo -e "${RED}Error: Unknown option '$1'${NC}"
                echo ""
                echo "Run 'setup-machine --help' to see available options"
                exit 1
                ;;
        esac
    done
    
    # Validate required arguments
    if [ -z "$ARG_HOST" ]; then
        echo -e "${RED}Error: --host is required${NC}"
        exit 1
    fi
    
    if [ -z "$ARG_REMOTE_USER" ]; then
        echo -e "${RED}Error: --remote-user is required${NC}"
        exit 1
    fi
    
    # Validate remote user
    if ! validate_username "$ARG_REMOTE_USER"; then
        echo -e "${RED}Error: Invalid remote user '$ARG_REMOTE_USER'${NC}"
        echo "Must be lowercase alphanumeric with underscores/hyphens (2-32 chars)"
        exit 1
    fi
    
    # Validate host
    if ! validate_host "$ARG_HOST"; then
        echo -e "${RED}Error: Invalid host '$ARG_HOST'${NC}"
        echo "Must be a valid IP address or hostname"
        exit 1
    fi
    
    # Validate port
    if ! validate_port "$ARG_PORT"; then
        echo -e "${RED}Error: Invalid port '$ARG_PORT'${NC}"
        echo "Must be a number between 1 and 65535"
        exit 1
    fi
    
    # Validate remote authentication: either password or key must be provided
    if [ -z "$ARG_REMOTE_PASSWORD" ] && [ -z "$ARG_REMOTE_KEY" ]; then
        echo -e "${RED}Error: Either --remote-password or --remote-key must be provided${NC}"
        exit 1
    fi
    
    if [ -n "$ARG_REMOTE_PASSWORD" ] && [ -n "$ARG_REMOTE_KEY" ]; then
        echo -e "${RED}Error: Cannot use both --remote-password and --remote-key${NC}"
        echo "Please choose one authentication method"
        exit 1
    fi
    
    # Validate remote key exists if provided
    if [ -n "$ARG_REMOTE_KEY" ] && [ ! -f "$ARG_REMOTE_KEY" ]; then
        echo -e "${RED}Error: Remote key file not found: $ARG_REMOTE_KEY${NC}"
        exit 1
    fi
    
    # If deploy-user is provided, validate it
    if [ -n "$ARG_DEPLOY_USER" ]; then
        if ! validate_username "$ARG_DEPLOY_USER"; then
            echo -e "${RED}Error: Invalid deploy user '$ARG_DEPLOY_USER'${NC}"
            echo "Must be lowercase alphanumeric with underscores/hyphens (2-32 chars)"
            exit 1
        fi
        
        # If creating a user, password is required (unless generating key without password)
        if [ -z "$ARG_DEPLOY_PASSWORD" ]; then
            echo -e "${RED}Error: --deploy-password is required when creating a deploy user${NC}"
            exit 1
        fi
    fi
    
    # Validate deploy key exists if provided
    if [ -n "$ARG_DEPLOY_KEY" ] && [ ! -f "$ARG_DEPLOY_KEY" ]; then
        echo -e "${RED}Error: Deploy key file not found: $ARG_DEPLOY_KEY${NC}"
        exit 1
    fi
    
    # Validate generate-key value
    if [[ "$ARG_GENERATE_KEY" != "y" ]] && [[ "$ARG_GENERATE_KEY" != "n" ]]; then
        echo -e "${RED}Error: --generate-key must be 'y' or 'n'${NC}"
        exit 1
    fi
    
    # If not generating key and no deploy key provided, and deploy-user is set, error
    if [ -n "$ARG_DEPLOY_USER" ] && [ "$ARG_GENERATE_KEY" = "n" ] && [ -z "$ARG_DEPLOY_KEY" ]; then
        echo -e "${RED}Error: When creating a deploy user, either --generate-key y or --deploy-key must be provided${NC}"
        exit 1
    fi
    
    # Validate portainer installation
    if [[ "$ARG_INSTALL_PORTAINER" != "y" ]] && [[ "$ARG_INSTALL_PORTAINER" != "n" ]]; then
        echo -e "${RED}Error: --install-portainer must be 'y' or 'n'${NC}"
        exit 1
    fi
    
    # If installing portainer, validate required fields
    if [ "$ARG_INSTALL_PORTAINER" = "y" ]; then
        if [ -z "$ARG_PORTAINER_PASSWORD" ]; then
            echo -e "${RED}Error: --portainer-password is required when installing Portainer${NC}"
            exit 1
        fi
        
        if ! validate_port "$ARG_PORTAINER_PORT"; then
            echo -e "${RED}Error: Invalid Portainer port '$ARG_PORTAINER_PORT'${NC}"
            exit 1
        fi
        
        if [ -n "$ARG_PORTAINER_DOMAIN" ] && ! validate_domain_name "$ARG_PORTAINER_DOMAIN"; then
            echo -e "${RED}Error: Invalid Portainer domain '$ARG_PORTAINER_DOMAIN'${NC}"
            exit 1
        fi
    fi
    
    # Validate portainer domain (optional)
    if [ -n "$ARG_PORTAINER_DOMAIN" ] && ! validate_domain_name "$ARG_PORTAINER_DOMAIN"; then
        echo -e "${RED}Error: Invalid Portainer domain '$ARG_PORTAINER_DOMAIN'${NC}"
        exit 1
    fi
    
    # Export all variables
    export ARG_HOST ARG_PORT ARG_REMOTE_USER ARG_REMOTE_PASSWORD ARG_REMOTE_KEY
    export ARG_DEPLOY_USER ARG_DEPLOY_PASSWORD ARG_DEPLOY_KEY ARG_GENERATE_KEY
    export ARG_INSTALL_PORTAINER ARG_PORTAINER_PASSWORD ARG_PORTAINER_PORT ARG_PORTAINER_DOMAIN
    
    return 0
}

export -f parse_setup_machine_args
