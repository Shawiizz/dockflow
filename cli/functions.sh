#!/bin/bash

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    echo -e "\n\n${YELLOW}Script interrupted by user. Goodbye!${NC}"
    jobs -p | xargs -r kill
    exit 1
}

print_heading() {
    echo -e "\n${BLUE}== $1 ==${NC}"
}

print_success() {
    echo -e "${GREEN}$1${NC}"
}

print_warning() {
    echo -e "${YELLOW}$1${NC}"
}
