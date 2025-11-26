#!/bin/bash

setup_machine_interactive() {
	echo -e "${GREEN}=========================================================="
	echo "   MACHINE SETUP"
	echo -e "==========================================================${NC}"

	print_heading "SETUP TYPE"
	echo ""
	echo -e "${CYAN}Choose an option:${NC}"
	echo ""

	local options=(
		"Setup this machine (Local)"
		"Display connection information for existing user"
	)

	interactive_menu "Select option:" "${options[@]}"
	SETUP_TYPE=$?

	if [ "$SETUP_TYPE" = "0" ]; then
		# Local setup
		setup_machine
	elif [ "$SETUP_TYPE" = "1" ]; then
		# Display connection information only
		echo ""
		echo -e "${CYAN}Display connection information for an existing deployment user${NC}"
		echo ""

		# Detect defaults
		DEFAULT_IP=$(detect_public_ip)
		DEFAULT_PORT=$(detect_ssh_port)

		# Ask for server details
		prompt_host "Server IP address (for connection string)" SERVER_IP "$DEFAULT_IP"
		prompt_port "SSH port (for connection string)" SSH_PORT "$DEFAULT_PORT"

		# Ask for deployment user
		prompt_username "Deployment user name" DISPLAY_USER "dockflow"

		echo ""

		export SERVER_IP
		export SSH_PORT
		export DOCKFLOW_USER="$DISPLAY_USER"

		echo ""
		echo -e "${GREEN}=========================================================="
		echo "   CONNECTION INFORMATION"
		echo -e "===========================================================${NC}"
		echo ""

		# Display connection information
		display_deployment_connection_info "${SERVER_IP}" "${SSH_PORT}" "${DOCKFLOW_USER}"

		# Return to main menu
		return 0
	else
		print_warning "Invalid option."
		exit 1
	fi
}

export -f setup_machine_interactive
