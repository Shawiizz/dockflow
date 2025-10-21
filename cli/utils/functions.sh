#!/bin/bash

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
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

print_info() {
    echo -e "${CYAN}$1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_step() {
    echo -e "${BLUE}➜ $1${NC}"
}

print_tip() {
    echo -e "${YELLOW}💡 Tip: $1${NC}"
}

# Interactive menu with arrow key navigation
# Usage: interactive_menu "Prompt text" "Option 1" "Option 2" "Option 3" ...
# Returns: Selected index (0-based)
interactive_menu() {
    local prompt="$1"
    shift
    local options=("$@")
    local selected=0
    local num_options=${#options[@]}
    
    # Hide cursor
    tput civis
    
    # Function to draw menu
    draw_menu() {
        echo -e "${CYAN}${prompt}${NC}"
        echo ""
        for i in "${!options[@]}"; do
            if [ $i -eq $selected ]; then
                echo -e "  ${GREEN}▸ ${options[$i]}${NC}"
            else
                echo -e "    ${options[$i]}"
            fi
        done
        echo ""
        echo -e "${YELLOW}Navigation: ↑↓ arrows to move, Enter to select, 'q' to quit${NC}"
    }
    
    # Initial draw
    draw_menu
    
    # Read arrow keys
    while true; do
        # Read a single character
        IFS= read -rsn1 key
        
        # Handle different key codes
        case "$key" in
            $'\x1b')  # ESC sequence
                read -rsn2 -t 0.1 key  # Read the rest of the escape sequence
                case "$key" in
                    '[A')  # Up arrow
                        ((selected--))
                        if [ $selected -lt 0 ]; then
                            selected=$((num_options - 1))
                        fi
                        ;;
                    '[B')  # Down arrow
                        ((selected++))
                        if [ $selected -ge $num_options ]; then
                            selected=0
                        fi
                        ;;
                esac
                ;;
            '')  # Enter key
                # Show cursor
                tput cnorm
                echo ""
                return $selected
                ;;
            'q'|'Q')  # Quit
                tput cnorm
                echo ""
                print_warning "Exiting CLI..."
                exit 0
                ;;
        esac
        
        # Clear previous menu (move up by number of options + 3 lines for prompt and help)
        tput cuu $((num_options + 3))
        tput ed
        
        # Redraw menu
        draw_menu
    done
}
