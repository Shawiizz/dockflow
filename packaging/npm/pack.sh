#!/bin/sh
# Builds the npm packages of a release from the binaries in dist/ (ADR-0020):
# @dockflow-tools/cli, which runs the binary, and one @dockflow-tools/cli-<os>-<arch> per platform,
# its optional dependencies, each limited to its platform by os and cpu.
#
#   packaging/npm/pack.sh <version> <dist> <out>
set -eu

version=$1
dist=$2
out=$3
here=$(cd "$(dirname "$0")" && pwd)
repo='"repository": { "type": "git", "url": "git+https://github.com/Shawiizz/dockflow.git" }'

rm -rf "$out"
deps=""
for p in linux-x64:linux:x64:linux-amd64 linux-arm64:linux:arm64:linux-arm64 darwin-x64:darwin:x64:darwin-amd64 \
	darwin-arm64:darwin:arm64:darwin-arm64 win32-x64:win32:x64:windows-amd64; do
	IFS=: read -r name os cpu bin <<EOF
$p
EOF
	ext=""
	[ "$os" = win32 ] && ext=.exe
	d="$out/cli-$name"
	mkdir -p "$d/bin"
	cp "$dist/dockflow-$bin$ext" "$d/bin/dockflow$ext"
	chmod 755 "$d/bin/dockflow$ext"
	cat >"$d/package.json" <<EOF
{
  "name": "@dockflow-tools/cli-$name",
  "version": "$version",
  "description": "The dockflow binary for $os/$cpu, installed by @dockflow-tools/cli.",
  "license": "MIT",
  $repo,
  "os": ["$os"],
  "cpu": ["$cpu"],
  "files": ["bin"]
}
EOF
	deps="$deps${deps:+,
}    \"@dockflow-tools/cli-$name\": \"$version\""
done

d="$out/cli"
mkdir -p "$d/bin"
cp "$here/dockflow.js" "$d/bin/dockflow.js"
cp "$here/README.md" "$d/README.md"
cat >"$d/package.json" <<EOF
{
  "name": "@dockflow-tools/cli",
  "version": "$version",
  "description": "Deploy Docker Compose apps to your own servers.",
  "homepage": "https://dockflow.shawiizz.dev",
  "license": "MIT",
  $repo,
  "bin": { "dockflow": "bin/dockflow.js" },
  "files": ["bin"],
  "engines": { "node": ">=18" },
  "optionalDependencies": {
$deps
  }
}
EOF
echo "packages in $out"
