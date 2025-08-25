#!/bin/bash
set -e

HOST_SUFFIX=""

for arg in "$@"; do
  case $arg in
    --host=*)
      HOST_SUFFIX="${arg#*=}"
      shift
      ;;
    *)
      ;;
  esac
done

cd deployment/docker

if [[ -n "$HOST_SUFFIX" ]]; then
  OUTPUT_DIR="docker_images_${HOST_SUFFIX}"
else
  OUTPUT_DIR="docker_images"
fi

mkdir -p "$(dirname "$OUTPUT_DIR")"

DECOMPOSERIZE_OPTIONS="--docker-build"
if [[ -n "$DEPLOY_DOCKER_SERVICES" ]]; then
  echo "Building services for host ${HOST_SUFFIX:-main}: $DEPLOY_DOCKER_SERVICES"
  DECOMPOSERIZE_OPTIONS="$DECOMPOSERIZE_OPTIONS --services=$DEPLOY_DOCKER_SERVICES"
fi

BUILD_CMDS=$(decomposerize compose-deploy.yml $DECOMPOSERIZE_OPTIONS)

if [[ -z "$BUILD_CMDS" ]]; then
  echo "No services to build for host ${HOST_SUFFIX:-main}"
  exit 0
fi

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
    
    if [[ -z "$OUTPUT_DIR" ]]; then
      echo "Error: OUTPUT_DIR is empty"
      return 1
    fi
    
    mkdir -p "$OUTPUT_DIR"
    
    if [[ ! -w "$OUTPUT_DIR" ]]; then
      echo "Error: No write permission for $OUTPUT_DIR"
      return 1
    fi
    
    docker save -o "$OUTPUT_DIR/$TAR_NAME" "$IMAGE_NAME"
    echo "Image saved to: $(realpath "$OUTPUT_DIR/$TAR_NAME")"
  fi
}

export -f build_image
export OUTPUT_DIR

IMAGE_COUNT=$(echo "$BUILD_CMDS" | wc -l)
if [ "$IMAGE_COUNT" -gt 1 ]; then
  echo "Detected $IMAGE_COUNT images to build for host ${HOST_SUFFIX:-main}. Running in parallel with $PARALLEL_JOBS jobs..."
  
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