#!/bin/bash
set -e

cd deployment/docker

BUILD_CMDS=$(decomposerize compose-deploy.yml --docker-build)

while IFS= read -r BUILD_CMD; do
  echo "Running: $BUILD_CMD"
  eval "$BUILD_CMD"

  IMAGE_NAME=$(echo "$BUILD_CMD" | sed -nE 's/.*-t\s+"?([^"]+)"?.*/\1/p')
  IMAGE_NAME=$(eval echo "$IMAGE_NAME")
  echo "Image built: $IMAGE_NAME"

  if [[ "$ENV" != "build" ]]; then
    TAR_NAME="${IMAGE_NAME//:/-}.tar"
    docker save -o "$TAR_NAME" "$IMAGE_NAME"

    echo "::group::Upload $TAR_NAME"
    echo "artifact: image-${IMAGE_NAME}"
    echo "Path: $(realpath "$TAR_NAME")"
    echo "::endgroup::"
  fi
done <<< "$BUILD_CMDS"