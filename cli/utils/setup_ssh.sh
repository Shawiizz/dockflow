#!/bin/bash

source "$CLI_UTILS_DIR/functions.sh"

list_and_select_ssh_key() {
	local ssh_dir="$HOME/.ssh"

	if [ ! -d "$ssh_dir" ]; then
		print_warning "SSH directory $ssh_dir not found"
		return 1
	fi

	# Find private key files (exclude .pub, known_hosts, config, etc.)
	local private_keys=()
	while IFS= read -r -d '' file; do
		# Check if it's likely a private key (not .pub, not known_hosts, not config)
		local basename
		basename=$(basename "$file")
		if [[ ! "$basename" =~ \.(pub|known_hosts|config)$ ]] && [[ "$basename" != "known_hosts" ]] && [[ "$basename" != "config" ]]; then
			# Additional check: private keys typically start with specific headers
			if head -1 "$file" 2>/dev/null | grep -q "BEGIN.*PRIVATE KEY\|BEGIN OPENSSH PRIVATE KEY\|BEGIN RSA PRIVATE KEY\|BEGIN DSA PRIVATE KEY\|BEGIN EC PRIVATE KEY"; then
				private_keys+=("$file")
			fi
		fi
	done < <(find "$ssh_dir" -type f -print0 2>/dev/null)

	if [ ${#private_keys[@]} -eq 0 ]; then
		print_warning "No private SSH keys found in $ssh_dir"
		return 1
	fi

	print_heading "AVAILABLE SSH PRIVATE KEYS"

	local options=()
	for key_file in "${private_keys[@]}"; do
		local key_name
		key_name=$(basename "$key_file")
		options+=("$key_name ($(dirname "$key_file")/$key_name)")
	done

	interactive_menu "Select a private key:" "${options[@]}"
	local choice=$?

	SSH_PRIVATE_KEY_PATH="${private_keys[$choice]}"
	print_success "Selected: $(basename "$SSH_PRIVATE_KEY_PATH")"
	return 0
}

generate_ansible_ssh_key() {
	print_heading "SSH KEY SETUP"

	# Check if SSH key already exists for the deployment user
	KEY_EXISTS=false
	EXISTING_PUBLIC_KEY=""

	# Check if key exists for deployment user locally
	if [ -n "${DOCKFLOW_USER:-}" ] && [ "$DOCKFLOW_USER" != "$(whoami)" ]; then
		# Different user - check in their home directory using stored sudo password
		if echo "${BECOME_PASSWORD:-}" | sudo -S test -f "/home/$DOCKFLOW_USER/.ssh/dockflow_key" 2>/dev/null; then
			KEY_EXISTS=true
			EXISTING_PUBLIC_KEY=$(echo "${BECOME_PASSWORD:-}" | sudo -S cat "/home/$DOCKFLOW_USER/.ssh/dockflow_key.pub" 2>/dev/null || echo "")
		fi
	else
		# Same user - check in current home
		if [ -f ~/.ssh/dockflow_key ]; then
			KEY_EXISTS=true
			EXISTING_PUBLIC_KEY=$(cat ~/.ssh/dockflow_key.pub 2>/dev/null || echo "")
		fi
	fi

	# If key exists, ask if user wants to regenerate
	if [ "$KEY_EXISTS" = true ]; then
		echo ""
		print_step "SSH key already exists for user $DOCKFLOW_USER"
		echo ""

		if confirm_action "Do you want to regenerate the SSH key for user $DOCKFLOW_USER?" "n"; then
			print_warning "A new SSH key will be generated"
			GENERATE_ANSIBLE_KEY="y"
		else
			print_success "Using existing SSH key for user $DOCKFLOW_USER"
			GENERATE_ANSIBLE_KEY="n"

			# Use the existing public key
			if [ -n "$EXISTING_PUBLIC_KEY" ]; then
				ANSIBLE_PUBLIC_KEY="$EXISTING_PUBLIC_KEY"
				export ANSIBLE_PUBLIC_KEY
			fi

			return 0
		fi
	else
		# No key exists, generate one
		GENERATE_ANSIBLE_KEY="y"
	fi

	if [ "$GENERATE_ANSIBLE_KEY" = "y" ] || [ "$GENERATE_ANSIBLE_KEY" = "Y" ]; then
		echo ""
		print_success "Generating new SSH key pair for deployment user $DOCKFLOW_USER..."

		TEMP_KEY_DIR=$(mktemp -d)
		ssh-keygen -t ed25519 -f "$TEMP_KEY_DIR/dockflow_key" -N "" -C "dockflow-$DOCKFLOW_USER" >/dev/null 2>&1
		ANSIBLE_PUBLIC_KEY=$(cat "$TEMP_KEY_DIR/dockflow_key.pub")
		ANSIBLE_PRIVATE_KEY=$(cat "$TEMP_KEY_DIR/dockflow_key")

		# Copy to ~/.ssh/deploy_key locally for CLI use
		mkdir -p ~/.ssh
		echo "$ANSIBLE_PRIVATE_KEY" >~/.ssh/deploy_key
		chmod 600 ~/.ssh/deploy_key

		print_success "SSH key pair generated successfully"
		echo ""

		rm -rf "$TEMP_KEY_DIR"
	else
		# Ask for existing key
		print_heading "SELECT EXISTING PRIVATE KEY"

		echo ""
		if ! list_and_select_ssh_key; then
			print_warning "No SSH key selected or available. Exiting..."
			exit 1
		fi

		ANSIBLE_PRIVATE_KEY_PATH="$SSH_PRIVATE_KEY_PATH"

		if [ ! -f "$ANSIBLE_PRIVATE_KEY_PATH" ]; then
			print_warning "Private key not found at $ANSIBLE_PRIVATE_KEY_PATH"
			exit 1
		fi

		# Check if corresponding public key exists
		ANSIBLE_PUBLIC_KEY_PATH="${ANSIBLE_PRIVATE_KEY_PATH}.pub"
		if [ ! -f "$ANSIBLE_PUBLIC_KEY_PATH" ]; then
			print_warning "Public key not found at $ANSIBLE_PUBLIC_KEY_PATH"
			print_warning "Trying to generate public key from private key..."
			if ssh-keygen -y -f "$ANSIBLE_PRIVATE_KEY_PATH" >"$ANSIBLE_PUBLIC_KEY_PATH" 2>/dev/null; then
				print_success "Public key generated successfully"
			else
				print_warning "Failed to generate public key. Please ensure the private key is valid."
				exit 1
			fi
		fi

		ANSIBLE_PUBLIC_KEY=$(cat "$ANSIBLE_PUBLIC_KEY_PATH")

		print_success "Copying private key to ~/.ssh/deploy_key"
		mkdir -p ~/.ssh
		cp "$ANSIBLE_PRIVATE_KEY_PATH" ~/.ssh/deploy_key
		chmod 600 ~/.ssh/deploy_key
	fi

	export ANSIBLE_PUBLIC_KEY
}
