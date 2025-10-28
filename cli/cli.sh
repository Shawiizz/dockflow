#!/bin/bash

CLI_SCRIPT_DIR="/setup/cli"
source "$CLI_SCRIPT_DIR/config.sh"

# Define colors early for help/version
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

show_help() {
    cat << EOF
$(echo -e "${GREEN}========================================================")
$(echo -e "   Dockflow CLI v$CLI_VERSION")
$(echo -e "   Setup and manage your infrastructure")
$(echo -e "========================================================${NC}")

$(echo -e "${CYAN}USAGE:${NC}")
    docker run -it --rm \\
        -e HOST_PWD="\$(pwd)" \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest [OPTIONS]

$(echo -e "${CYAN}OPTIONS:${NC}")
    -h, --help              Show this help message
    -v, --version           Show version information
    init [github|gitlab]    Initialize project structure (default: github)
    
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
    • Local machine: Docker Desktop installed
    • SSH directory mounted: ~/.ssh:/root/.ssh
    • Project directory mounted: .:/project
    
$(echo -e "${CYAN}EXAMPLES:${NC}")
    # Start interactive setup
    docker run -it --rm \\
        -e HOST_PWD="\$(pwd)" \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest
    
    # Initialize project structure directly
    docker run -it --rm \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest init
    
    # Initialize with specific platform
    docker run -it --rm \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/dockflow-cli:latest init gitlab
    
    # Show help
    docker run -it --rm shawiizz/dockflow-cli:latest --help
    
    # Show version
    docker run -it --rm shawiizz/dockflow-cli:latest --version
    
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

# Source dependencies first
source "$CLI_UTILS_DIR/functions.sh"
source "$CLI_UTILS_DIR/validators.sh"
source "$CLI_UTILS_DIR/setup_ssh.sh"
source "$CLI_UTILS_DIR/create_ansible_user.sh"
source "$CLI_UTILS_DIR/run_ansible.sh"
source "$CLI_UTILS_DIR/quick_scan.sh"
source "$CLI_UTILS_DIR/analyze_project.sh"
source "$CLI_UTILS_DIR/manage_environments.sh"

source "$CLI_COMMANDS_DIR/setup_machine.sh"
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
        "")
            # No arguments, continue to interactive mode
            return 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option '$1'${NC}"
            echo ""
            echo "Run with --help to see available options"
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
        options+=("Setup a remote machine or modify installation")
        
        if [ $project_exists -eq 0 ]; then
            options+=("Edit current project")
        else
            options+=("Initialize project structure in the current directory")
        fi
        
        options+=("Exit")
        
        interactive_menu "Select an option:" "${options[@]}"
        MAIN_OPTION=$?

        if [ "$MAIN_OPTION" = "0" ]; then
            setup_machine
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
