#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source config which will detect Docker vs native mode
source "$SCRIPT_DIR/config.sh"

# Define colors early for help/version
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

show_help() {
    if [ "$RUNNING_IN_DOCKER" = true ]; then
        local usage_cmd="docker run -it --rm \\
        -e HOST_PWD=\"\$(pwd)\" \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest [COMMAND] [OPTIONS]"
    else
        local usage_cmd="./cli/cli.sh [COMMAND] [OPTIONS]"
    fi
    
    cat << EOF
$(echo -e "${GREEN}========================================================")
$(echo -e "   Dockflow CLI v$CLI_VERSION")
$(echo -e "   Setup and manage your infrastructure")
$(echo -e "========================================================${NC}")

$(echo -e "${CYAN}USAGE:${NC}")
    $usage_cmd

$(echo -e "${CYAN}COMMANDS:${NC}")
    (no command)            Start interactive mode (default)
    -h, --help              Show this help message
    -v, --version           Show version information
    init [github|gitlab]    Initialize project structure (default: github)
    setup-machine           Setup remote machine for deployment (non-interactive)
    
$(echo -e "${CYAN}SETUP-MACHINE OPTIONS:${NC}")
    Required:
      --host HOST                    Remote server IP or hostname
      --remote-user USER             Remote user for initial connection
      --remote-password PASS         Password for remote user
        OR
      --remote-key PATH              SSH private key for remote user
    
    Deploy User (optional - if provided, a new user will be created):
      --deploy-user USER             Name of deployment user to create
      --deploy-password PASS         Password for deployment user (required if --deploy-user)
      --deploy-key PATH              SSH private key for deployment user
      --generate-key y|n             Generate new SSH key (default: n)
    
    Optional:
      --port PORT                    SSH port (default: 22)
      --install-portainer y|n        Install Portainer (default: n)
      --portainer-password PASS      Portainer admin password
      --portainer-port PORT          Portainer HTTP port (default: 9000)
      --portainer-domain DOMAIN      Portainer domain name (optional)
    
    
$(echo -e "${CYAN}DESCRIPTION:${NC}")
    This CLI tool helps you:
    • Setup remote machines for Docker deployment
    • Configure deployment users and SSH keys
    • Initialize project deployment structures
    • Manage multiple environments (production, staging, etc.)
    • Deploy Docker applications via CI/CD pipelines
    
$(echo -e "${CYAN}INTERACTIVE MODE:${NC}")
    When run without options, the CLI starts in interactive mode
    with a menu-driven interface for easy navigation.
    
$(echo -e "${CYAN}FEATURES:${NC}")
    • Automated server setup (Debian/Ubuntu)
    • SSH key management
    • Docker and Portainer installation
    • Multi-environment deployment configuration
    • CI/CD pipeline setup (GitHub Actions, GitLab CI)
    
$(echo -e "${CYAN}REQUIREMENTS:${NC}")
    • Remote server: Debian/Ubuntu with SSH access
    • Local machine: Ansible installed (native mode) or Docker Desktop (Docker mode)
    • SSH access to remote server
    
$(echo -e "${CYAN}EXAMPLES:${NC}")
EOF
    
    if [ "$RUNNING_IN_DOCKER" = true ]; then
        cat << EOF
    ${YELLOW}# Docker Mode Examples${NC}
    
    # Start interactive setup
    docker run -it --rm \\
        -e HOST_PWD="\$(pwd)" \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest
    
    # Initialize project structure
    docker run -it --rm \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest init
    
    # Setup machine with password
    docker run -it --rm \\
        -v \${HOME}/.ssh:/root/.ssh \\
        shawiizz/dockflow-cli:latest setup-machine \\
          --host 192.168.1.10 \\
          --remote-user root \\
          --remote-password "rootpass" \\
          --deploy-user dockflow \\
          --deploy-password "deploypass" \\
          --generate-key y
EOF
    else
        cat << EOF
    ${YELLOW}# Native Mode Examples${NC}
    
    # Start interactive setup
    ./cli/cli.sh
    
    # Initialize project structure
    ./cli/cli.sh init github
    
    # Setup machine with password
    ./cli/cli.sh setup-machine \\
      --host 192.168.1.10 \\
      --remote-user root \\
      --remote-password "rootpass" \\
      --deploy-user dockflow \\
      --deploy-password "deploypass" \\
      --generate-key y
    
    # Setup machine with SSH key
    ./cli/cli.sh setup-machine \\
      --host server.example.com \\
      --remote-user admin \\
      --remote-key ~/.ssh/id_rsa
    
    # Setup with Portainer
    ./cli/cli.sh setup-machine \\
      --host prod.example.com \\
      --remote-user root \\
      --remote-password "pass" \\
      --deploy-user dockflow \\
      --deploy-password "deploypass" \\
      --generate-key y \\
      --install-portainer y \\
      --portainer-password "portainerpass" \\
      --portainer-domain portainer.example.com
    
    # Show help
    ./cli/cli.sh --help
    
    # Show version
    ./cli/cli.sh --version
EOF
    fi
    
    cat << EOF
    
$(echo -e "${CYAN}DOCUMENTATION:${NC}")
    Full documentation: https://github.com/Shawiizz/dockflow
    Report issues: https://github.com/Shawiizz/dockflow/issues
    
$(echo -e "${CYAN}LICENSE:${NC}")
    MIT License - Copyright (c) Shawiizz
    
EOF
}

show_version() {
    echo -e "${GREEN}Dockflow CLI${NC}"
    echo -e "Version: ${CYAN}$CLI_VERSION${NC}"
    echo -e "Repository: ${BLUE}https://github.com/Shawiizz/dockflow${NC}"
    echo -e "License: MIT"
}

show_setup_machine_help() {
    if [ "$RUNNING_IN_DOCKER" = true ]; then
        local usage_cmd="docker run -it --rm \\
        -v \${HOME}/.ssh:/root/.ssh \\
        shawiizz/dockflow-cli:latest setup-machine [OPTIONS]"
    else
        local usage_cmd="./cli/cli.sh setup-machine [OPTIONS]"
    fi
    
    cat << EOF
$(echo -e "${GREEN}========================================================")
$(echo -e "   Setup Machine - Non-Interactive Mode")
$(echo -e "========================================================${NC}")

$(echo -e "${CYAN}USAGE:${NC}")
    $usage_cmd

$(echo -e "${CYAN}REQUIRED OPTIONS:${NC}")
    --host HOST                    Remote server IP or hostname
    --remote-user USER             Remote user for initial connection
    
    Authentication (choose one):
      --remote-password PASS       Password for remote user
      --remote-key PATH            SSH private key path for remote user

$(echo -e "${CYAN}DEPLOY USER OPTIONS (optional):${NC}")
    If you provide --deploy-user, a new user will be created on the remote server.
    If not provided, the remote user will be used for deployments.
    
    --deploy-user USER             Name of deployment user to create
    --deploy-password PASS         Password for deployment user (required if --deploy-user)
    
    SSH Key for deploy user (choose one):
      --deploy-key PATH            Use existing SSH private key
      --generate-key y             Generate new SSH key pair

$(echo -e "${CYAN}OPTIONAL SETTINGS:${NC}")
    --port PORT                    SSH port (default: 22)

$(echo -e "${CYAN}PORTAINER OPTIONS (optional):${NC}")
    --install-portainer y          Install Portainer for container management
    --portainer-password PASS      Portainer admin password (required if installing)
    --portainer-port PORT          Portainer HTTP port (default: 9000)
    --portainer-domain DOMAIN      Portainer domain name (optional)

$(echo -e "${CYAN}EXAMPLES:${NC}")
EOF
    
    if [ "$RUNNING_IN_DOCKER" = true ]; then
        cat << EOF
    
    $(echo -e "${YELLOW}1. Basic setup with password (creates deploy user):${NC}")
    docker run -it --rm -v \${HOME}/.ssh:/root/.ssh \\
        shawiizz/dockflow-cli:latest setup-machine \\
        --host 192.168.1.10 \\
        --remote-user root \\
        --remote-password "mypassword" \\
        --deploy-user dockflow \\
        --deploy-password "deploypass" \\
        --generate-key y
    
    $(echo -e "${YELLOW}2. Setup with SSH key (no new user):${NC}")
    docker run -it --rm -v \${HOME}/.ssh:/root/.ssh \\
        shawiizz/dockflow-cli:latest setup-machine \\
        --host server.example.com \\
        --remote-user admin \\
        --remote-key /root/.ssh/id_rsa
    
    $(echo -e "${YELLOW}3. Full setup with Portainer:${NC}")
    docker run -it --rm -v \${HOME}/.ssh:/root/.ssh \\
        shawiizz/dockflow-cli:latest setup-machine \\
        --host 192.168.1.10 \\
        --remote-user root \\
        --remote-password "rootpass" \\
        --deploy-user dockflow \\
        --deploy-password "deploypass" \\
        --generate-key y \\
        --install-portainer y \\
        --portainer-password "portainerpass" \\
        --portainer-port 9000 \\
        --portainer-domain portainer.example.com
EOF
    else
        cat << EOF
    
    $(echo -e "${YELLOW}1. Basic setup with password (creates deploy user):${NC}")
    ./cli/cli.sh setup-machine \\
        --host 192.168.1.10 \\
        --remote-user root \\
        --remote-password "mypassword" \\
        --deploy-user dockflow \\
        --deploy-password "deploypass" \\
        --generate-key y
    
    $(echo -e "${YELLOW}2. Setup with SSH key (no new user):${NC}")
    ./cli/cli.sh setup-machine \\
        --host server.example.com \\
        --remote-user admin \\
        --remote-key ~/.ssh/id_rsa
    
    $(echo -e "${YELLOW}3. Setup with existing deploy key:${NC}")
    ./cli/cli.sh setup-machine \\
        --host prod.example.com \\
        --remote-user root \\
        --remote-password "pass" \\
        --deploy-user dockflow \\
        --deploy-password "deploypass" \\
        --deploy-key ~/.ssh/deploy_rsa
    
    $(echo -e "${YELLOW}4. Full setup with Portainer:${NC}")
    ./cli/cli.sh setup-machine \\
        --host 192.168.1.10 \\
        --remote-user root \\
        --remote-password "rootpass" \\
        --deploy-user dockflow \\
        --deploy-password "deploypass" \\
        --generate-key y \\
        --install-portainer y \\
        --portainer-password "portainerpass" \\
        --portainer-port 9000 \\
        --portainer-domain portainer.example.com
EOF
    fi
    
    cat << EOF

$(echo -e "${CYAN}NOTES:${NC}")
    • If --deploy-user is provided, a new user will be created
    • If --deploy-user is omitted, the remote user will be used for deployments
    • SSH keys are stored in ~/.ssh/deploy_key for later use
    • Portainer domain is optional and used for reverse proxy configuration
    
EOF
}

# Source dependencies first
source "$CLI_UTILS_DIR/functions.sh"
source "$CLI_UTILS_DIR/validators.sh"
source "$CLI_UTILS_DIR/parse_args.sh"
source "$CLI_UTILS_DIR/setup_ssh.sh"
source "$CLI_UTILS_DIR/create_ansible_user.sh"
source "$CLI_UTILS_DIR/run_ansible.sh"
source "$CLI_UTILS_DIR/connection_string.sh"
source "$CLI_UTILS_DIR/quick_scan.sh"
source "$CLI_UTILS_DIR/analyze_project.sh"
source "$CLI_UTILS_DIR/manage_environments.sh"

source "$CLI_COMMANDS_DIR/setup_machine.sh"
source "$CLI_COMMANDS_DIR/setup_machine_interactive.sh"
source "$CLI_COMMANDS_DIR/setup_machine_non_interactive.sh"
source "$CLI_COMMANDS_DIR/setup_project.sh"

trap cleanup SIGINT
trap 'tput cnorm' EXIT  # Always restore cursor on exit

# Function to initialize project structure (non-interactive)
init_project_non_interactive() {
    local ci_platform="$1"
    
    echo -e "${GREEN}=========================================================="
    echo "   INITIALIZING PROJECT STRUCTURE"
    echo -e "==========================================================${NC}"
    echo ""
    echo -e "${CYAN}CI/CD Platform:${NC} $ci_platform"
    echo -e "${CYAN}Target Directory:${NC} .deployment/"
    echo ""
    
    # Use the common function from setup_project.sh
    create_project_structure "$ci_platform"
    
    echo ""
    echo -e "${GREEN}✓ Project initialized successfully in .deployment/${NC}"
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo "  1. Configure your .deployment/env/.env.production file"
    echo "  2. Set up your docker-compose.yml and Dockerfiles"
    echo "  3. Configure CI/CD secrets in your repository"
    echo "  4. Push your changes and create a tag to deploy"
    echo ""
}

# Parse command line arguments
parse_arguments() {
    case "${1:-}" in
        -h|--help)
            show_help
            exit 0
            ;;
        -v|--version)
            show_version
            exit 0
            ;;
        init|--init)
            # Initialize project structure directly (non-interactive)
            local ci_platform="${2:-github}"
            
            # Validate platform
            if [[ "$ci_platform" != "github" && "$ci_platform" != "gitlab" ]]; then
                echo -e "${RED}Error: Invalid CI platform '$ci_platform'. Use 'github' or 'gitlab'.${NC}"
                exit 1
            fi
            
            init_project_non_interactive "$ci_platform"
            exit 0
            ;;
        setup-machine)
            # Setup machine in non-interactive mode
            shift  # Remove 'setup-machine' from arguments
            
            # Check if --help is requested
            if [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
                show_setup_machine_help
                exit 0
            fi
            
            # Parse setup-machine arguments
            parse_setup_machine_args "$@"
            
            # Run non-interactive setup
            setup_machine_non_interactive
            exit 0
            ;;
        "")
            # No arguments, continue to interactive mode
            return 0
            ;;
        *)
            echo -e "${RED}Error: Unknown command '$1'${NC}"
            echo ""
            echo "Run with --help to see available commands"
            exit 1
            ;;
    esac
}

# Parse arguments after functions are defined
parse_arguments "$@"

show_main_menu() {
    while true; do
        clear
        echo -e "${GREEN}=========================================================="
        echo "   Dockflow CLI v$CLI_VERSION"
        echo -e "==========================================================${NC}"
        
        # Show current directory (only if HOST_PWD is set)
        if [ -n "$HOST_PWD" ]; then
            echo ""
            echo -e "${CYAN}Working directory:${NC} $HOST_PWD"
            echo ""
        fi
        
        # Quick scan of the project
        display_quick_scan
        local project_exists=$?

        local options=()
        options+=("Configure remote machine for deployment")
        
        if [ $project_exists -eq 0 ]; then
            options+=("Edit current project")
        else
            options+=("Initialize project structure in the current directory")
        fi
        
        options+=("Exit")
        
        interactive_menu "Select an option:" "${options[@]}"
        MAIN_OPTION=$?

        if [ "$MAIN_OPTION" = "0" ]; then
            setup_machine_interactive
            echo ""
        elif [ "$MAIN_OPTION" = "1" ]; then
            setup_project
            echo ""
        elif [ "$MAIN_OPTION" = "2" ]; then
            echo ""
            tput cnorm  # Restore cursor
            print_success "Thank you for using Dockflow CLI. Goodbye!"
            exit 0
        else
            print_warning "Invalid option."
            exit 1
        fi
    done
}

show_main_menu
