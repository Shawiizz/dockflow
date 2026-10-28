#!/bin/sh
# Installs the dockflow CLI from a GitHub release (ADR-0020). The binary is checked against the
# release's SHA256SUMS, and SHA256SUMS against its Sigstore signature when cosign is installed.
#
#   curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | sh -s -- --version vX.Y.Z --dir ~/bin
#
# DOCKFLOW_VERSION and DOCKFLOW_INSTALL_DIR do the same as the options. DOCKFLOW_RELEASES_URL
# replaces https://github.com/Shawiizz/dockflow/releases/download (a mirror).
set -eu

repo=Shawiizz/dockflow
version="${DOCKFLOW_VERSION:-}"
dir="${DOCKFLOW_INSTALL_DIR:-}"
releases="${DOCKFLOW_RELEASES_URL:-https://github.com/$repo/releases/download}"

while [ $# -gt 0 ]; do
	case "$1" in
	--version) version="$2"; shift 2 ;;
	--dir) dir="$2"; shift 2 ;;
	*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
	esac
done

fail() { echo "install.sh: $*" >&2; exit 1; }

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
linux | darwin) ;;
*) fail "no installer for $os; download dockflow-windows-amd64.exe from https://github.com/$repo/releases" ;;
esac
arch=$(uname -m)
case "$arch" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "no dockflow binary for $arch" ;;
esac

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1"
	else
		fail "curl or wget is required"
	fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -z "$version" ]; then
	# the newest release of this CLI: its tags are v<semver>
	fetch "https://api.github.com/repos/$repo/releases?per_page=50" "$tmp/releases.json" || fail "cannot list the releases; pass --version"
	version=$(grep -o '"tag_name": *"v[0-9][^"]*"' "$tmp/releases.json" | head -n 1 | sed 's/.*"\(v[^"]*\)"$/\1/')
	[ -n "$version" ] || fail "no release found; pass --version"
fi

case "$version" in [0-9]*) version="v$version" ;; esac

name="dockflow-$os-$arch"
base="$releases/$version"
echo "installing dockflow $version ($os/$arch)"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "cannot download $base/SHA256SUMS"
fetch "$base/$name" "$tmp/$name" || fail "cannot download $base/$name"

if command -v cosign >/dev/null 2>&1; then
	fetch "$base/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS.sigstore.json" || fail "cannot download the signature of SHA256SUMS"
	cosign verify-blob --bundle "$tmp/SHA256SUMS.sigstore.json" \
		--certificate-identity-regexp "^https://github.com/$repo/.github/workflows/release.yml@refs/(tags/v|heads/main$)" \
		--certificate-oidc-issuer https://token.actions.githubusercontent.com \
		"$tmp/SHA256SUMS" >/dev/null 2>&1 || fail "the signature of SHA256SUMS does not verify"
	echo "signature verified"
else
	echo "cosign is not installed: checking the checksum only"
fi

want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "the release lists no $name"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp/$name" | awk '{ print $1 }')
else
	got=$(shasum -a 256 "$tmp/$name" | awk '{ print $1 }')
fi
[ "$got" = "$want" ] || fail "$name does not match its checksum"

if [ -z "$dir" ]; then
	if [ -w /usr/local/bin ]; then
		dir=/usr/local/bin
	else
		dir="$HOME/.local/bin"
	fi
fi
mkdir -p "$dir"
chmod 755 "$tmp/$name"
mv "$tmp/$name" "$dir/dockflow"
echo "installed $dir/dockflow"

case ":$PATH:" in
*":$dir:"*) ;;
*)
	if [ -n "${GITHUB_PATH:-}" ]; then
		echo "$dir" >>"$GITHUB_PATH"
	else
		echo "add $dir to your PATH"
	fi
	;;
esac
