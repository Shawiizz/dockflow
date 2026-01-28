#!/bin/bash
# Dockflow CLI Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | bash
set -e

# Version to install
VERSION="2.0.12"

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
	DOWNLOAD_URL="https://github.com/Shawiizz/dockflow/releases/latest/download/${BINARY_NAME}"
else
	DOWNLOAD_URL="https://github.com/Shawiizz/dockflow/releases/download/${VERSION}/${BINARY_NAME}"
fi

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

# Download
if command -v curl &>/dev/null; then
	curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_PATH"
elif command -v wget &>/dev/null; then
	wget -q "$DOWNLOAD_URL" -O "$INSTALL_PATH"
else
	echo "Error: curl or wget is required"
	exit 1
fi

# Make executable
chmod +x "$INSTALL_PATH"

echo "✓ Dockflow CLI installed to $INSTALL_PATH"
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
