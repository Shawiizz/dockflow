#!/bin/bash

setup_project() {
    print_heading "PROJECT SETUP"
            
    echo "Select CI/CD platform:"
    echo "1) GitHub Actions"
    echo "2) GitLab CI"
    read -rp "Choose option (1/2): " CI_OPTION
    
    # Create directory structure
    mkdir -p "$CLI_PROJECT_DIR/ci"
    mkdir -p "$CLI_PROJECT_DIR/.deployment/docker"
    mkdir -p "$CLI_PROJECT_DIR/.deployment/env"
    mkdir -p "$CLI_PROJECT_DIR/.deployment/templates/nginx"
    mkdir -p "$CLI_PROJECT_DIR/.deployment/templates/scripts"
    
    # Create .env.production with required configuration
    ENV_PROD_FILE="$CLI_PROJECT_DIR/.deployment/env/.env.production"
    if [ ! -f "$ENV_PROD_FILE" ]; then
        echo "HOST=to_replace" > "$ENV_PROD_FILE"
        echo "ANSIBLE_USER=ansible|to_replace" >> "$ENV_PROD_FILE"
        print_success "Created .env.production file with placeholder values"
    else
        print_warning ".env.production file already exists, skipping"
    fi
    
    # Setup CI configuration based on user choice
    if [ "$CI_OPTION" = "1" ]; then
        mkdir -p "$CLI_PROJECT_DIR/.github/workflows"
        GITHUB_CI_FILE="$CLI_PROJECT_DIR/.github/workflows/github-ci.yml"
        if [ ! -f "$GITHUB_CI_FILE" ]; then
            touch "$GITHUB_CI_FILE"
            print_success "Created empty GitHub Actions CI configuration"
        else
            print_warning "GitHub Actions CI configuration already exists, skipping"
        fi
    else
        GITLAB_CI_FILE="$CLI_PROJECT_DIR/.gitlab-ci.yml"
        if [ ! -f "$GITLAB_CI_FILE" ]; then
            touch "$GITLAB_CI_FILE"
            print_success "Created empty GitLab CI configuration"
        else
            print_warning "GitLab CI configuration already exists, skipping"
        fi
    fi
    
    create_empty_file_if_not_exists "$CLI_PROJECT_DIR/.deployment/docker/docker-compose.yml"
    create_empty_file_if_not_exists "$CLI_PROJECT_DIR/.deployment/docker/Dockerfile.to_replace"
    
    print_success "Project structure set up successfully"
}

create_empty_file_if_not_exists() {
    local file_path="$1"
    if [ ! -f "$file_path" ]; then
        touch "$file_path"
        print_success "Created empty file: $(basename "$file_path")"
    else
        print_warning "File already exists, skipping: $(basename "$file_path")"
    fi
}

export -f setup_project
export -f create_empty_file_if_not_exists
