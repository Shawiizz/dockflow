#!/bin/bash

CLI_SCRIPT_DIR="/setup/cli"
source "$CLI_SCRIPT_DIR/config.sh"

source "$CLI_UTILS_DIR/functions.sh"
source "$CLI_UTILS_DIR/setup_ssh.sh"
source "$CLI_UTILS_DIR/create_ansible_user.sh"
source "$CLI_UTILS_DIR/run_ansible.sh"

source "$CLI_COMMANDS_DIR/setup_machine.sh"
source "$CLI_COMMANDS_DIR/setup_project.sh"

trap cleanup SIGINT

show_main_menu() {
    echo -e "${GREEN}=========================================================="
    echo "   DEVOPS AUTOMATION CLI v$CLI_VERSION"
    echo -e "==========================================================${NC}"

    print_heading "MAIN MENU"
    echo "1) Setup a remote machine"
    echo "2) Setup a new project"
    read -rp "Choose option (1/2): " MAIN_OPTION

    if [ "$MAIN_OPTION" = "1" ]; then
        setup_machine
    elif [ "$MAIN_OPTION" = "2" ]; then
        setup_project
    else
        print_warning "Invalid option. Please run the script again and select 1 or 2."
        exit 1
    fi
}

show_main_menu
