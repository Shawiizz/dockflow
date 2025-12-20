#!/bin/bash
# Rollback healthcheck script
# Arguments: SERVICE TIMEOUT

SERVICE="$1"
TIMEOUT="${2:-60}"
ELAPSED=0
INTERVAL=5

echo "Waiting for rolled back service $SERVICE to become healthy..."

while [ $ELAPSED -lt $TIMEOUT ]; do
  # Get the running container
  TASK_ID=$(docker service ps $SERVICE --filter "desired-state=running" --format '{{.ID}}' 2>/dev/null | head -1)
  
  if [ -z "$TASK_ID" ]; then
    echo "No running task found, waiting..."
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
    continue
  fi
  
  CONTAINER_ID=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' $TASK_ID 2>/dev/null | head -c 12)
  
  if [ -z "$CONTAINER_ID" ]; then
    echo "Container not ready, waiting..."
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
    continue
  fi
  
  HEALTH_STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $CONTAINER_ID 2>/dev/null || echo "unknown")
  
  if [ "$HEALTH_STATUS" = "healthy" ] || [ "$HEALTH_STATUS" = "none" ]; then
    echo "Rolled back service $SERVICE is now healthy"
    exit 0
  fi
  
  echo "Service $SERVICE health status: $HEALTH_STATUS, waiting..."
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

echo "WARNING: Rolled back service $SERVICE did not become healthy within timeout"
exit 1
