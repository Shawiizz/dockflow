#!/bin/bash
# Swarm service healthcheck script
# Arguments: SERVICE EXPECTED_IMAGE TIMEOUT

SERVICE="$1"
EXPECTED_IMAGE="$2"
TIMEOUT="${3:-120}"
ELAPSED=0
INTERVAL=5

echo "Checking health status for service: $SERVICE"
echo "Expected image: $EXPECTED_IMAGE"

while [ $ELAPSED -lt $TIMEOUT ]; do
  # Get running tasks with their image and node (use | as separator since image contains :)
  TASK_INFO=$(docker service ps $SERVICE --filter "desired-state=running" --format '{{.ID}}|{{.Image}}|{{.Node}}' 2>/dev/null)
  
  if [ -z "$TASK_INFO" ]; then
    echo "No running tasks found for $SERVICE, waiting..."
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
    continue
  fi
  
  # First check if any task has wrong image (real rollback indicator)
  HAS_WRONG_IMAGE=false
  while IFS= read -r task_line; do
    RUNNING_IMAGE=$(echo "$task_line" | cut -d'|' -f2)
    if [ "$RUNNING_IMAGE" != "$EXPECTED_IMAGE" ]; then
      HAS_WRONG_IMAGE=true
      break
    fi
  done <<< "$TASK_INFO"
  
  # Only check UpdateStatus if we see wrong images (actual rollback in progress)
  if [ "$HAS_WRONG_IMAGE" = "true" ]; then
    UPDATE_STATE=$(docker service inspect $SERVICE --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}none{{end}}' 2>/dev/null || echo "none")
    
    if [ "$UPDATE_STATE" = "rollback_completed" ]; then
      echo "ROLLBACK DETECTED: Service has rolled back to previous version (wrong image running)"
      exit 2
    elif [ "$UPDATE_STATE" = "rollback_started" ] || [ "$UPDATE_STATE" = "rollback_paused" ]; then
      echo "Rollback in progress, waiting..."
      sleep $INTERVAL
      ELAPSED=$((ELAPSED + INTERVAL))
      continue
    fi
  fi
  
  # Get local hostname to identify local vs remote tasks
  LOCAL_HOSTNAME=$(hostname)
  
  # Check all tasks for this service
  ALL_HEALTHY=true
  CHECKED_ANY=false
  
  while IFS= read -r task_line; do
    TASK_ID=$(echo "$task_line" | cut -d'|' -f1)
    RUNNING_IMAGE=$(echo "$task_line" | cut -d'|' -f2)
    TASK_NODE=$(echo "$task_line" | cut -d'|' -f3)
    
    # Check image matches expected
    if [ "$RUNNING_IMAGE" != "$EXPECTED_IMAGE" ]; then
      echo "Task $TASK_ID: image mismatch ($RUNNING_IMAGE vs $EXPECTED_IMAGE), waiting for update..."
      ALL_HEALTHY=false
      continue
    fi
    
    # For tasks on remote nodes (workers), just verify they are running
    if [ "$TASK_NODE" != "$LOCAL_HOSTNAME" ]; then
      TASK_STATE=$(docker service ps $SERVICE --filter "id=$TASK_ID" --format '{{.CurrentState}}' 2>/dev/null | head -1)
      if echo "$TASK_STATE" | grep -q "Running"; then
        echo "Task $TASK_ID on $TASK_NODE: Running (remote node - trusting Swarm)"
        CHECKED_ANY=true
      else
        echo "Task $TASK_ID on $TASK_NODE: $TASK_STATE (not running yet)"
        ALL_HEALTHY=false
      fi
      continue
    fi
    
    # For local tasks, do full healthcheck inspection
    CHECKED_ANY=true
    CONTAINER_ID=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' $TASK_ID 2>/dev/null | head -c 12)
    
    if [ -z "$CONTAINER_ID" ]; then
      echo "Task $TASK_ID: container not yet created"
      ALL_HEALTHY=false
      continue
    fi
    
    HEALTH_STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $CONTAINER_ID 2>/dev/null || echo "unknown")
    
    if [ "$HEALTH_STATUS" = "none" ]; then
      echo "Task $TASK_ID on $TASK_NODE: no healthcheck - OK"
    elif [ "$HEALTH_STATUS" = "healthy" ]; then
      echo "Task $TASK_ID on $TASK_NODE: healthy"
    elif [ "$HEALTH_STATUS" = "starting" ]; then
      echo "Task $TASK_ID on $TASK_NODE: healthcheck starting..."
      ALL_HEALTHY=false
    elif [ "$HEALTH_STATUS" = "unhealthy" ]; then
      echo "Task $TASK_ID on $TASK_NODE: UNHEALTHY"
      ALL_HEALTHY=false
    else
      echo "Task $TASK_ID on $TASK_NODE: status=$HEALTH_STATUS"
      ALL_HEALTHY=false
    fi
  done <<< "$TASK_INFO"
  
  if [ "$ALL_HEALTHY" = "true" ] && [ "$CHECKED_ANY" = "true" ]; then
    echo "All tasks for $SERVICE are healthy"
    exit 0
  fi
  
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

# Final check: verify if running image matches expected
FINAL_TASK_INFO=$(docker service ps $SERVICE --filter "desired-state=running" --format '{{.Image}}' 2>/dev/null | head -1)
if [ -n "$FINAL_TASK_INFO" ] && [ "$FINAL_TASK_INFO" != "$EXPECTED_IMAGE" ]; then
  # Wrong image running - check if it's due to rollback
  UPDATE_STATE=$(docker service inspect $SERVICE --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}none{{end}}' 2>/dev/null || echo "none")
  if [ "$UPDATE_STATE" = "rollback_completed" ]; then
    echo "ROLLBACK DETECTED: Running image ($FINAL_TASK_INFO) differs from expected ($EXPECTED_IMAGE)"
    exit 2
  fi
  echo "Image mismatch after timeout: running=$FINAL_TASK_INFO expected=$EXPECTED_IMAGE"
  exit 1
fi

echo "Timeout waiting for $SERVICE healthchecks"
exit 1
