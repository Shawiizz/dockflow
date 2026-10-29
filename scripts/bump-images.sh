#!/bin/sh
# Moves each third-party image Dockflow pins (internal/agent/images.go) to the newest release of
# its major version, and to the digest of that release's multi-platform index. Running it again
# changes nothing until a registry publishes a new release, or moves a tag to new content.
# Needs Go, for crane.
set -eu

cd "$(dirname "$0")/.."
file=internal/agent/images.go
crane_version=v0.22.1

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
GOBIN="$tmp" go install "github.com/google/go-containerregistry/cmd/crane@$crane_version"
crane="$tmp/crane"

# the pinned references: "<repository>:<x.y.z>@sha256:<digest>"
grep -oE '"[a-z0-9./_-]+:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}"' "$file" | tr -d '"' >"$tmp/refs"
if [ ! -s "$tmp/refs" ]; then
	echo "no pinned image in $file" >&2
	exit 1
fi
while read -r ref; do
	repository=${ref%%:*}
	tag=${ref#*:}
	tag=${tag%%@*}
	major=${tag%%.*}
	# releases only: no pre-release, no variant (-alpine, -builder, windows…)
	latest=$("$crane" ls "$repository" | grep -E "^$major\.[0-9]+\.[0-9]+\$" | sort -V | tail -n 1)
	if [ -z "$latest" ]; then
		echo "$repository: no $major.x.y release" >&2
		exit 1
	fi
	digest=$("$crane" digest "$repository:$latest")
	# servers are amd64 or arm64: the digest must be an index holding both
	"$crane" manifest "$repository@$digest" >"$tmp/manifest"
	for arch in amd64 arm64; do
		if ! grep -q "\"architecture\": *\"$arch\"" "$tmp/manifest"; then
			echo "$repository:$latest has no linux/$arch image" >&2
			exit 1
		fi
	done
	new="$repository:$latest@$digest"
	if [ "$new" != "$ref" ]; then
		echo "$ref -> $new"
		sed "s|\"$ref\"|\"$new\"|" "$file" >"$tmp/images.go"
		cat "$tmp/images.go" >"$file"
	fi
done <"$tmp/refs"
