#!/bin/bash
set -e

cd deployment/docker

BUILD_CMDS=$(decomposerize compose-deploy.yml --docker-build)
PARALLEL_JOBS=$(nproc 2>/dev/null || echo 4)

build_image() {
  local BUILD_CMD="$1"
  echo "Running: $BUILD_CMD"
  eval "$BUILD_CMD"

  local IMAGE_NAME=$(echo "$BUILD_CMD" | sed -nE 's/.*-t\s+"?([^"]+)"?.*/\1/p')
  IMAGE_NAME=$(eval echo "$IMAGE_NAME")
  echo "Image built: $IMAGE_NAME"

  if [[ "$ENV" != "build" ]]; then
    local TAR_NAME="${IMAGE_NAME//:/-}.tar"
    docker save -o "$TAR_NAME" "$IMAGE_NAME"

    echo "::group::Upload $TAR_NAME"
    echo "artifact: image-${IMAGE_NAME}"
    echo "Path: $(realpath "$TAR_NAME")"
    echo "::endgroup::"
  fi
}

export -f build_image

IMAGE_COUNT=$(echo "$BUILD_CMDS" | wc -l)
if [ "$IMAGE_COUNT" -gt 1 ]; then
  echo "Detected $IMAGE_COUNT images to build. Running in parallel with $PARALLEL_JOBS jobs..."
  
  if ! command -v parallel &>/dev/null; then
    echo "Installing GNU parallel..."
    apt-get update -qq && apt-get install -qq -y parallel
  fi
  
  # Run build commands in parallel
  echo "$BUILD_CMDS" | parallel --jobs "$PARALLEL_JOBS" build_image
else
  # Only one image to build, running sequentially
  while IFS= read -r BUILD_CMD; do
    build_image "$BUILD_CMD"
  done <<< "$BUILD_CMDS"
fi