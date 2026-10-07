#!/bin/bash
# Dockflow CLI Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | bash
set -e

# Version to install (override with DOCKFLOW_VERSION env var)
VERSION="${DOCKFLOW_VERSION:-latest}"

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
linux*)
	OS="linux"
	;;
darwin*)
	OS="macos"
	;;
mingw* | msys* | cygwin*)
	OS="windows"
	;;
*)
	echo "Unsupported OS: $OS"
	exit 1
	;;
esac

case "$ARCH" in
x86_64 | amd64)
	ARCH="x64"
	;;
aarch64 | arm64)
	ARCH="arm64"
	;;
*)
	echo "Unsupported architecture: $ARCH"
	exit 1
	;;
esac

# Build download URL
BINARY_NAME="dockflow-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then
	BINARY_NAME="${BINARY_NAME}.exe"
fi

if [ "$VERSION" = "latest" ]; then
	RELEASE_URL="https://github.com/Shawiizz/dockflow/releases/latest/download"
else
	RELEASE_URL="https://github.com/Shawiizz/dockflow/releases/download/${VERSION}"
fi
DOWNLOAD_URL="${RELEASE_URL}/${BINARY_NAME}"
# Every release publishes the SHA-256 of its binaries
SUMS_URL="${RELEASE_URL}/SHA256SUMS"

# Determine install location
if [ "$OS" = "windows" ]; then
	INSTALL_DIR="$HOME/bin"
	INSTALL_PATH="$INSTALL_DIR/dockflow.exe"
else
	if [ -w "/usr/local/bin" ]; then
		INSTALL_DIR="/usr/local/bin"
	else
		INSTALL_DIR="$HOME/.local/bin"
	fi
	INSTALL_PATH="$INSTALL_DIR/dockflow"
fi

# Create install directory if needed
mkdir -p "$INSTALL_DIR"

echo "Downloading Dockflow CLI..."
echo "  Version: $VERSION"
echo "  Platform: $OS-$ARCH"
echo "  URL: $DOWNLOAD_URL"
echo ""

# Download into a temporary directory: the binary reaches INSTALL_PATH only once verified
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

download() {
	if command -v curl &>/dev/null; then
		curl -fsSL "$1" -o "$2"
	elif command -v wget &>/dev/null; then
		wget -q "$1" -O "$2"
	else
		echo "Error: curl or wget is required"
		exit 1
	fi
}

sha256() {
	if command -v sha256sum &>/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum &>/dev/null; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		echo "Error: sha256sum or shasum is required to verify the download" >&2
		exit 1
	fi
}

download "$DOWNLOAD_URL" "$TMP_DIR/$BINARY_NAME"
if ! download "$SUMS_URL" "$TMP_DIR/SHA256SUMS"; then
	echo "Error: release $VERSION publishes no SHA256SUMS, so the download cannot be verified."
	echo "Releases made before checksums can be downloaded by hand: https://github.com/Shawiizz/dockflow/releases"
	exit 1
fi

EXPECTED="$(awk -v name="$BINARY_NAME" '$2 == name || $2 == "*" name { print $1 }' "$TMP_DIR/SHA256SUMS")"
ACTUAL="$(sha256 "$TMP_DIR/$BINARY_NAME")"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
	echo "Error: the SHA-256 of $BINARY_NAME does not match the release."
	echo "  Expected: ${EXPECTED:-nothing listed for $BINARY_NAME}"
	echo "  Got:      $ACTUAL"
	exit 1
fi

# Make executable, then move into place
chmod +x "$TMP_DIR/$BINARY_NAME"
mv "$TMP_DIR/$BINARY_NAME" "$INSTALL_PATH"

echo "✓ Dockflow CLI installed to $INSTALL_PATH (SHA-256 verified)"
echo ""

# Check if in PATH
if ! command -v dockflow &>/dev/null; then
	echo "Note: Add $INSTALL_DIR to your PATH:"
	if [ "$OS" = "linux" ] || [ "$OS" = "macos" ]; then
		echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc"
		echo "  source ~/.bashrc"
	fi
fi

echo ""
echo "Run 'dockflow --help' to get started"
