#!/bin/bash
# Dockflow CLI Wrapper - One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/develop/cli/cli_wrapper.sh?$(date +%s) | bash
# Usage with specific branch: curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/cli/cli_wrapper.sh?$(date +%s) | BRANCH=main bash
# The ?$(date +%s) adds a timestamp to bypass GitHub's CDN cache

set -eo pipefail
IFS=$'\n\t'

# Branch to use (default: main)
BRANCH="${BRANCH:-main}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}                     Dockflow CLI Installer                        ${NC}"
echo -e "${CYAN}                         Branch: $BRANCH                           ${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to install package
install_package() {
    local package="$1"
    echo -e "${YELLOW}Installing $package...${NC}"
    
    if command_exists apt-get; then
        sudo apt-get update -qq
        sudo apt-get install -y "$package"
    elif command_exists yum; then
        sudo yum install -y "$package"
    elif command_exists dnf; then
        sudo dnf install -y "$package"
    elif command_exists pacman; then
        sudo pacman -S --noconfirm "$package"
    else
        echo -e "${RED}Error: Could not detect package manager${NC}"
        echo -e "${YELLOW}Please install $package manually${NC}"
        exit 1
    fi
}

echo -e "${BLUE}[1/5] Checking required dependencies...${NC}"

# Check and install required tools
MISSING_DEPS=()

if ! command_exists curl; then
    MISSING_DEPS+=("curl")
fi

if ! command_exists unzip; then
    MISSING_DEPS+=("unzip")
fi

if ! command_exists ansible; then
    MISSING_DEPS+=("ansible")
fi

if ! command_exists jq; then
    MISSING_DEPS+=("jq")
fi

if ! command_exists sshpass; then
    MISSING_DEPS+=("sshpass")
fi

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Missing dependencies detected: ${MISSING_DEPS[*]}${NC}"
    echo -e "${YELLOW}Installing missing dependencies...${NC}"
    
    for dep in "${MISSING_DEPS[@]}"; do
        install_package "$dep"
    done
    
    echo -e "${GREEN}✓ All dependencies installed${NC}"
else
    echo -e "${GREEN}✓ All dependencies are already installed${NC}"
fi

# Check Python version
echo -e "${BLUE}[2/5] Checking Python version...${NC}"
if command_exists python3; then
    PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
    echo -e "${GREEN}✓ Python $PYTHON_VERSION detected${NC}"
else
    echo -e "${RED}Error: Python 3 is required but not found${NC}"
    install_package "python3"
fi

# Check Ansible version
echo -e "${BLUE}[3/5] Checking Ansible version...${NC}"
ANSIBLE_VERSION=$(ansible --version 2>&1 | head -n1 | awk '{print $2}')
echo -e "${GREEN}✓ Ansible $ANSIBLE_VERSION detected${NC}"

# Create temporary directory
echo -e "${BLUE}[4/5] Downloading Dockflow CLI...${NC}"
TEMP_DIR=$(mktemp -d -t dockflow-XXXXXXXXXX)
trap 'rm -rf "$TEMP_DIR"' EXIT

cd "$TEMP_DIR"

# Download repository archive
ARCHIVE_URL="https://github.com/Shawiizz/dockflow/archive/refs/heads/${BRANCH}.zip"
echo -e "${YELLOW}Downloading repository archive from ${BRANCH} branch...${NC}"

if ! curl -fsSL -o dockflow.zip "$ARCHIVE_URL"; then
    echo -e "${RED}Error: Failed to download repository archive${NC}"
    echo -e "${YELLOW}Please check that the branch '${BRANCH}' exists${NC}"
    exit 1
fi

# Extract archive
echo -e "${YELLOW}Extracting files...${NC}"
unzip -q dockflow.zip

# Find extracted directory (format: dockflow-<branch>)
EXTRACTED_DIR=$(find . -maxdepth 1 -type d -name "dockflow-*" | head -n 1)

if [ -z "$EXTRACTED_DIR" ]; then
    echo -e "${RED}Error: Could not find extracted directory${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Dockflow CLI downloaded${NC}"

# Make CLI executable
chmod +x "${EXTRACTED_DIR}/cli/cli.sh"

# Run the CLI
echo -e "${BLUE}[5/5] Starting Dockflow CLI...${NC}"
echo ""

cd "$EXTRACTED_DIR"
exec bash -c "./cli/cli.sh $*" < /dev/tty

# Cleanup is handled by trap
