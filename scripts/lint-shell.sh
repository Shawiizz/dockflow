#!/usr/bin/env bash


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

# Track failures
FAILED=0

printf '%s\0' "${MAPFILE[@]}" | xargs -0 shellcheck -x --exclude=SC1091 || FAILED=1

# Optionally run shfmt to check formatting
# The pipeline reports differences without writing them
echo "Checking shell formatting with shfmt..."
# Ensure shfmt is on PATH
if ! command -v shfmt >/dev/null 2>&1; then
  echo "shfmt not installed; skipping shfmt check"
else
  # shfmt lists files that are not properly formatted
  # Using -d to show diffs in CI logs is often more helpful than just filenames
  if ! printf '%s\0' "${MAPFILE[@]}" | xargs -0 shfmt -d; then
      FAILED=1
  fi
fi

if [ $FAILED -ne 0 ]; then
    echo "Shell linting or formatting failed."
    exit 1
fi

echo "Shell checks completed."