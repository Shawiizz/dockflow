#!/bin/bash

# =============================================================================
# Setup Workspace - Creates a writable workspace with symlinks
# =============================================================================
#
# Purpose: Protect source files from modification during Jinja2 rendering
#
# Architecture:
#   /project   (read-only)  → Original source files from host
#   /workspace (writable)   → Symlinks + copied .deployment/
#
# After execution: ROOT_PATH=/workspace
# =============================================================================

set -e

readonly SOURCE_DIR="/project"
readonly WORKSPACE_DIR="/workspace"
readonly CONFIG_FILE="$WORKSPACE_DIR/.deployment/config.yml"

# =============================================================================
# Utility Functions
# =============================================================================

log_info()    { echo "  ✓ $1"; }
log_warning() { echo "  ⚠ $1"; }

# Check if a path is a symlink
is_symlink() { [ -L "$1" ]; }

# Check if a file exists
file_exists() { [ -f "$1" ]; }

# Check if a directory exists  
dir_exists() { [ -d "$1" ]; }

# =============================================================================
# Core Functions
# =============================================================================

# Create a symlink from workspace to source
# Usage: create_symlink "filename"
create_symlink() {
    local name="$1"
    ln -s "$SOURCE_DIR/$name" "$WORKSPACE_DIR/$name"
}

# Copy a file/directory from source to workspace
# Usage: copy_to_workspace "relative/path"
copy_to_workspace() {
    local relative_path="$1"
    local source="$SOURCE_DIR/$relative_path"
    local target="$WORKSPACE_DIR/$relative_path"
    
    mkdir -p "$(dirname "$target")"
    cp -r "$source" "$target"
}

# Materialize a symlink (replace with real content)
# Usage: materialize_path "relative/path"
materialize_path() {
    local relative_path="$1"
    local target="$WORKSPACE_DIR/$relative_path"
    local source="$SOURCE_DIR/$relative_path"
    local parent_dir=$(dirname "$target")
    local parent_relative=$(dirname "$relative_path")

    # If parent is a symlink, materialize entire directory
    if is_symlink "$parent_dir"; then
        rm "$parent_dir"
        copy_to_workspace "$parent_relative"
        log_info "Materialized directory: $parent_relative/"
        return
    fi

    # If target is a symlink, replace with real file
    if is_symlink "$target"; then
        rm "$target"
        file_exists "$source" && cp "$source" "$target"
    fi

    mkdir -p "$(dirname "$target")"
}

# =============================================================================
# Workspace Setup
# =============================================================================

# Create symlinks for all items at root level (except exclusions)
create_root_symlinks() {
    local exclude_pattern="$1"
    
    # Regular files and directories
    for item in "$SOURCE_DIR"/*; do
        [ -e "$item" ] || continue
        local name=$(basename "$item")
        [[ "$name" == $exclude_pattern ]] && continue
        create_symlink "$name"
    done
    
    # Hidden files and directories
    for item in "$SOURCE_DIR"/.[!.]*; do
        [ -e "$item" ] || continue
        local name=$(basename "$item")
        [[ "$name" == $exclude_pattern ]] && continue
        create_symlink "$name"
    done
}

# Prepare custom template destinations from config.yml
prepare_custom_templates() {
    file_exists "$CONFIG_FILE" || return 0
    command -v yq &>/dev/null || { log_warning "yq not found, skipping custom templates"; return 0; }

    local count=$(yq '.templates | length // 0' "$CONFIG_FILE" 2>/dev/null || echo "0")
    [ "$count" = "0" ] || [ -z "$count" ] && return 0

    log_info "Preparing $count custom template destination(s)..."

    for i in $(seq 0 $((count - 1))); do
        local dest=$(yq -r ".templates[$i].dest // .templates[$i]" "$CONFIG_FILE" 2>/dev/null)
        local src=$(yq -r ".templates[$i].src // .templates[$i]" "$CONFIG_FILE" 2>/dev/null)
        
        [ -z "$dest" ] || [ "$dest" = "null" ] && continue

        # Prepare destination for writing
        materialize_path "$dest"
        
        # Copy source if different from dest and is a symlink
        if [ "$src" != "$dest" ] && is_symlink "$WORKSPACE_DIR/$src"; then
            rm "$WORKSPACE_DIR/$src"
            copy_to_workspace "$src"
        fi
    done

    log_info "Custom template destinations ready"
}

# Main setup function
setup_workspace() {
    echo "Setting up workspace with symlinks..."
    
    mkdir -p "$WORKSPACE_DIR"

    # Copy .deployment/ (modified by Jinja2)
    if dir_exists "$SOURCE_DIR/.deployment"; then
        copy_to_workspace ".deployment"
        log_info "Copied .deployment/"
    fi

    # Symlink everything else
    create_root_symlinks ".deployment"
    log_info "Created symlinks for project files"

    # Prepare custom template destinations
    prepare_custom_templates

    echo ""
    echo "Workspace ready at $WORKSPACE_DIR"
    echo "  - Source (read-only): $SOURCE_DIR"
    echo "  - Writable: $WORKSPACE_DIR/.deployment/"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

setup_workspace
export ROOT_PATH="$WORKSPACE_DIR"
