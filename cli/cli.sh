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
$(echo -e "   DEVOPS AUTOMATION CLI v$CLI_VERSION")
$(echo -e "   Setup and manage your DevOps infrastructure")
$(echo -e "========================================================${NC}")

$(echo -e "${CYAN}USAGE:${NC}")
    docker run -it --rm \\
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/devops-cli:latest [OPTIONS]

$(echo -e "${CYAN}OPTIONS:${NC}")
    -h, --help              Show this help message
    -v, --version           Show version information
    
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
        -v \${HOME}/.ssh:/root/.ssh \\
        -v .:/project \\
        shawiizz/devops-cli:latest
    
    # Show help
    docker run -it --rm shawiizz/devops-cli:latest --help
    
    # Show version
    docker run -it --rm shawiizz/devops-cli:latest --version
    
$(echo -e "${CYAN}DOCUMENTATION:${NC}")
    Full documentation: https://github.com/Shawiizz/devops-framework
    Report issues: https://github.com/Shawiizz/devops-framework/issues
    
$(echo -e "${CYAN}LICENSE:${NC}")
    MIT License - Copyright (c) Shawiizz
    
EOF
}

show_version() {
    echo -e "${GREEN}DevOps Automation CLI${NC}"
    echo -e "Version: ${CYAN}$CLI_VERSION${NC}"
    echo -e "Repository: ${BLUE}https://github.com/Shawiizz/devops-framework${NC}"
    echo -e "License: MIT"
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

# Parse arguments before showing menu
parse_arguments "$@"

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

show_main_menu() {
    echo -e "${GREEN}=========================================================="
    echo "   DEVOPS AUTOMATION CLI v$CLI_VERSION"
    echo -e "==========================================================${NC}"
    
    # Quick scan of the project
    display_quick_scan
    local project_exists=$?

    local options=()
    options+=("Setup a remote machine or modify installation")
    
    if [ $project_exists -eq 0 ]; then
        options+=("Edit current project")
    else
        options+=("Setup a new project")
    fi
    
    interactive_menu "Select an option:" "${options[@]}"
    MAIN_OPTION=$?

    if [ "$MAIN_OPTION" = "0" ]; then
        setup_machine
    elif [ "$MAIN_OPTION" = "1" ]; then
        setup_project
    else
        print_warning "Invalid option."
        exit 1
    fi
}

show_main_menu
