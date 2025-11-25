#!/usr/bin/env bash
set -eo pipefail
IFS=$'\n\t'

# Run shellcheck and shfmt on repository shell scripts
# Excludes testing directory and vendor-like directories

echo "Searching for shell scripts..."
MAPFILE=()
while IFS= read -r -d $'\0' file; do
  MAPFILE+=("$file")
done < <(find . -type f -name "*.sh" -not -path "./testing/*" -not -path "./.git/*" -print0)

if [ ${#MAPFILE[@]} -eq 0 ]; then
  echo "No shell scripts found"
  exit 0
fi

echo "Running ShellCheck on ${#MAPFILE[@]} file(s)..."
# Use shellcheck -x to allow external sourced files when running shellcheck manually
# Exclude SC1091 (not following sourced files) as this is expected in CI
if ! command -v shellcheck >/dev/null 2>&1; then
  echo "Error: shellcheck not found on PATH. Please install it to run linting."
  echo "Installation options (choose one):"
  echo "  - WSL / Debian/Ubuntu: sudo apt update && sudo apt install -y shellcheck"
  echo "  - macOS (Homebrew): brew install shellcheck"
  echo "  - Windows (Scoop): scoop install shellcheck";
  echo "  - Windows (Chocolatey): choco install shellcheck";
  exit 1
fi
printf '%s\0' "${MAPFILE[@]}" | xargs -0 shellcheck -x --exclude=SC1091

# Optionally run shfmt to check formatting
# The pipeline reports differences without writing them
echo "Checking shell formatting with shfmt..."
# Ensure shfmt is on PATH
if ! command -v shfmt >/dev/null 2>&1; then
  echo "shfmt not installed; skipping shfmt check"
  exit 0
fi

# shfmt lists files that are not properly formatted
printf '%s\0' "${MAPFILE[@]}" | xargs -0 shfmt -l | tee /dev/stderr

echo "Shell checks completed."