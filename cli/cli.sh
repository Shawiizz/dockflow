#!/bin/bash

CLI_SCRIPT_DIR="/setup/cli"
source "$CLI_SCRIPT_DIR/config.sh"

source "$CLI_UTILS_DIR/functions.sh"
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
