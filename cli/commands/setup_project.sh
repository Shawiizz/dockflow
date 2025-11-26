#!/bin/bash

# Common function to create project structure
create_project_structure() {
	local ci_platform="$1" # "github" or "gitlab"

	print_step "Creating directory structure..."

	# Create directory structure
	mkdir -p "$CLI_PROJECT_DIR/.deployment/docker"
	mkdir -p "$CLI_PROJECT_DIR/.deployment/env"
	mkdir -p "$CLI_PROJECT_DIR/.deployment/templates/nginx"
	mkdir -p "$CLI_PROJECT_DIR/.deployment/templates/scripts"

	# Create .env.production with required configuration
	ENV_PROD_FILE="$CLI_PROJECT_DIR/.deployment/env/.env.production"
	if [ ! -f "$ENV_PROD_FILE" ]; then
		mkdir -p "$(dirname "$ENV_PROD_FILE")"
		echo "DOCKFLOW_HOST=to_replace" >"$ENV_PROD_FILE"
		echo "DOCKFLOW_PORT=22" >>"$ENV_PROD_FILE"
		echo "DOCKFLOW_USER=dockflow" >>"$ENV_PROD_FILE"
		print_success "Created .env.production file"
	else
		print_warning ".env.production file already exists, skipping"
	fi

	# Setup CI configuration based on platform choice
	if [ "$ci_platform" = "github" ]; then
		mkdir -p "$CLI_PROJECT_DIR/.github/workflows"
		GITHUB_CI_FILE="$CLI_PROJECT_DIR/.github/workflows/github-ci.yml"
		if [ ! -f "$GITHUB_CI_FILE" ]; then
			touch "$GITHUB_CI_FILE"
			print_success "Created GitHub Actions CI configuration"
		else
			print_warning "GitHub Actions CI configuration already exists, skipping"
		fi
	else
		GITLAB_CI_FILE="$CLI_PROJECT_DIR/.gitlab-ci.yml"
		if [ ! -f "$GITLAB_CI_FILE" ]; then
			touch "$GITLAB_CI_FILE"
			print_success "Created GitLab CI configuration"
		else
			print_warning "GitLab CI configuration already exists, skipping"
		fi
	fi

	# Create docker files
	if [ ! -f "$CLI_PROJECT_DIR/.deployment/docker/docker-compose.yml" ]; then
		touch "$CLI_PROJECT_DIR/.deployment/docker/docker-compose.yml"
		print_success "Created docker-compose.yml"
	else
		print_warning "docker-compose.yml already exists, skipping"
	fi

	if [ ! -f "$CLI_PROJECT_DIR/.deployment/docker/Dockerfile.app" ]; then
		touch "$CLI_PROJECT_DIR/.deployment/docker/Dockerfile.app"
		print_success "Created Dockerfile.app"
	else
		print_warning "Dockerfile.app already exists, skipping"
	fi
}

# Interactive setup
setup_project() {
	# Check if project exists
	if quick_scan_project; then
		# Project exists, show detailed analysis
		display_project_analysis
		show_project_menu
		return
	fi

	# New project setup
	print_heading "NEW PROJECT SETUP"

	local options=(
		"GitHub Actions"
		"GitLab CI"
	)

	interactive_menu "Select CI/CD platform:" "${options[@]}"
	CI_OPTION=$?

	echo ""

	# Determine platform
	local ci_platform
	if [ "$CI_OPTION" = "0" ]; then
		ci_platform="github"
	else
		ci_platform="gitlab"
	fi

	# Create structure using common function
	create_project_structure "$ci_platform"

	echo ""
	echo -e "${GREEN}=========================================================="
	echo "   PROJECT INITIALIZED SUCCESSFULLY"
	echo -e "==========================================================${NC}"
	echo ""
	print_success "Project structure has been created in the current directory"
	echo ""
	echo -e "${CYAN}Next steps:${NC}"
	echo "  1. Configure your .deployment/env/.env.production file"
	echo "  2. Set up your docker-compose.yml and Dockerfiles"
	echo "  3. Configure CI/CD secrets in your repository"
	echo "  4. Push your changes and create a tag to deploy"
	echo ""

	safe_tput cnorm # Restore cursor
	exit 0
}

export -f create_project_structure
export -f setup_project
