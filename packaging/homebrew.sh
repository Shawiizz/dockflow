#!/bin/sh
# Writes the Homebrew formula of a release to stdout, from its SHA256SUMS (ADR-0020). The release
# workflow commits it as Formula/dockflow.rb, so this repository is its own tap:
#
#   brew tap shawiizz/dockflow https://github.com/Shawiizz/dockflow
#   brew install dockflow
#
#   packaging/homebrew.sh <version> <SHA256SUMS>
set -eu

version=$1
sums=$2
sum() {
	s=$(awk -v n="dockflow-$1" '$2 == n || $2 == "*" n { print $1 }' "$sums")
	[ -n "$s" ] || { echo "homebrew.sh: $sums lists no dockflow-$1" >&2; exit 1; }
	echo "$s"
}
url="https://github.com/Shawiizz/dockflow/releases/download/v$version"
mac_arm=$(sum darwin-arm64)
mac_intel=$(sum darwin-amd64)
linux_arm=$(sum linux-arm64)
linux_intel=$(sum linux-amd64)

cat <<EOF
# Written by packaging/homebrew.sh for each release: do not edit.
class Dockflow < Formula
  desc "Deploy Docker Compose apps to your own servers"
  homepage "https://dockflow.shawiizz.dev"
  version "$version"
  license "MIT"

  on_macos do
    on_arm do
      url "$url/dockflow-darwin-arm64"
      sha256 "$mac_arm"
    end
    on_intel do
      url "$url/dockflow-darwin-amd64"
      sha256 "$mac_intel"
    end
  end

  on_linux do
    on_arm do
      url "$url/dockflow-linux-arm64"
      sha256 "$linux_arm"
    end
    on_intel do
      url "$url/dockflow-linux-amd64"
      sha256 "$linux_intel"
    end
  end

  def install
    bin.install Dir["dockflow-*"].first => "dockflow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dockflow version")
  end
end
EOF
