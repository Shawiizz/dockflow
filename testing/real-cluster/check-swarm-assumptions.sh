#!/bin/sh
# Checks two assumptions Dockflow makes about Docker Swarm, on a real cluster. Run it on a manager.
#
#   U15  the order of the timestamp and of the "<task>@<node> |" prefix in `docker service logs`
#   U17  whether `docker stack deploy` collides with an overlay network that already carries the
#        name of the stack's default network (<stack>-accessories_default)
#
# It creates a throwaway service, a throwaway stack and a throwaway network, all named
# dockflow-check-*, and removes them when it ends (even when interrupted). Nothing else is touched.
# Paste the whole output back. See README.md next to this file.

set -u

PREFIX="dockflow-check-"
IMAGE="${CHECK_IMAGE:-alpine:3}"
LOGS_SERVICE="${PREFIX}logs"
APP_STACK="${PREFIX}app"
ACC_STACK="${APP_STACK}-accessories"
ACC_NET="${ACC_STACK}_default"

say() { printf '%s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }

command -v docker >/dev/null 2>&1 || { say "docker is not installed on this machine."; exit 2; }
if [ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)" != "true" ]; then
  say "This is not a Swarm manager: run the script on one."
  exit 2
fi

leftovers=$( { docker service ls --format '{{.Name}}'; docker stack ls --format '{{.Name}}'; docker network ls --format '{{.Name}}'; } 2>/dev/null | grep "^${PREFIX}")
if [ -n "$leftovers" ]; then
  say "Objects named ${PREFIX}* already exist, from an earlier run or from you:"
  say "$leftovers"
  say "Remove them (docker service rm / docker stack rm / docker network rm) and run the script again."
  exit 2
fi

WORK=$(mktemp -d) || exit 2

wait_stack_gone() {
  n=0
  while [ -n "$(docker stack ps "$1" -q 2>/dev/null)" ] && [ "$n" -lt 30 ]; do
    sleep 2
    n=$((n + 1))
  done
}

cleaned=0
cleanup() {
  [ "$cleaned" -eq 1 ] && return
  cleaned=1
  section "CLEANUP"
  docker service rm "$LOGS_SERVICE" >/dev/null 2>&1
  docker stack rm "$ACC_STACK" >/dev/null 2>&1
  wait_stack_gone "$ACC_STACK"
  n=0
  while docker network inspect "$ACC_NET" >/dev/null 2>&1 && [ "$n" -lt 30 ]; do
    docker network rm "$ACC_NET" >/dev/null 2>&1 || sleep 2
    n=$((n + 1))
  done
  rm -rf "$WORK"
  left=$( { docker service ls --format '{{.Name}}'; docker stack ls --format '{{.Name}}'; docker network ls --format '{{.Name}}'; } 2>/dev/null | grep "^${PREFIX}")
  if [ -n "$left" ]; then
    say "Left behind, to remove by hand:"
    say "$left"
  else
    say "Everything the script created is removed."
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

section "ENVIRONMENT"
say "docker server: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
say "nodes: $(docker node ls -q 2>/dev/null | wc -l | tr -d ' ')"
say "test image: $IMAGE"

# ---------------------------------------------------------------------------------------------
section "U15 docker service logs --timestamps"

# the loop runs inside the container, not here
# shellcheck disable=SC2016
LINES='for i in 1 2 3; do echo "line $i"; done; echo "a | b"; echo "2020-01-01T00:00:00Z fake-timestamp"; echo; echo "line 4"; sleep 3600'
u15="not checked"
if docker service create --detach --name "$LOGS_SERVICE" --replicas 2 --restart-condition none "$IMAGE" sh -c "$LINES" >"$WORK/create.out" 2>&1; then
  n=0
  running=0
  while [ "$running" -lt 2 ] && [ "$n" -lt 60 ]; do
    running=$(docker service ps "$LOGS_SERVICE" --filter desired-state=running --format '{{.CurrentState}}' 2>/dev/null | grep -c '^Running')
    [ "$running" -lt 2 ] && sleep 2
    n=$((n + 1))
  done
  sleep 2

  say "tasks: $running of 2 running"
  say "tasks and nodes:"
  docker service ps "$LOGS_SERVICE" --filter desired-state=running --format '  {{.Name}} on {{.Node}}: {{.CurrentState}}'

  docker service logs --tail 100 --timestamps --no-trunc "$LOGS_SERVICE" >"$WORK/logs.notrunc" 2>&1
  docker service logs --tail 100 --timestamps "$LOGS_SERVICE" >"$WORK/logs.default" 2>&1

  say ""
  say "--- docker service logs --tail 100 --timestamps --no-trunc (the API's command), first 14 lines, cat -vet ---"
  head -n 14 "$WORK/logs.notrunc" | cat -vet
  say ""
  say "--- docker service logs --tail 100 --timestamps (the logs command's), first 6 lines, cat -vet ---"
  head -n 6 "$WORK/logs.default" | cat -vet

  TS='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})'
  TASK='[^ @]+[.][^ @.]+[.][a-z0-9]+@[^ ]+ *[|] ?'
  total=$(wc -l <"$WORK/logs.notrunc" | tr -d ' ')
  ts_first=$(grep -cE "^${TS} ${TASK}" "$WORK/logs.notrunc")
  task_first=$(grep -cE "^${TASK}${TS}( |$)" "$WORK/logs.notrunc")
  in_order=$(awk '
    /line [0-9]+$/ {
      if (match($0, /[^ ]+@[^ ]+/)) task = substr($0, RSTART, RLENGTH); else task = "?"
      if (task in last && $NF + 0 <= last[task] + 0) bad = 1
      last[task] = $NF
    }
    END { print bad ? "no" : "yes" }' "$WORK/logs.notrunc")

  say ""
  say "lines: $total; timestamp then '<task>@<node> |': $ts_first; '<task>@<node> |' then timestamp: $task_first"
  say "numbered lines in order within each task: $in_order"
  if [ "$total" -gt 0 ] && [ "$ts_first" -eq "$total" ]; then
    u15="every line is: timestamp, then '<task>@<node> |', then the message"
  elif [ "$total" -gt 0 ] && [ "$task_first" -eq "$total" ]; then
    u15="every line is: '<task>@<node> |', then timestamp, then the message"
  else
    u15="MIXED OR UNEXPECTED: $ts_first timestamp-first, $task_first task-first, of $total lines (read the raw lines above)"
  fi
  say "verdict: $u15"
  say "Dockflow reads both orders (parseDockerLogLines in cli/src/utils/docker-logs.ts); the 'a | b' line and the line"
  say "whose message looks like a timestamp must come back as their message, not as a prefix."
else
  say "could not create the throwaway service:"
  cat "$WORK/create.out"
  u15="skipped: the service could not be created"
fi

# ---------------------------------------------------------------------------------------------
section "U17 an overlay network named like the stack's default network"

u17a="not checked"
u17b="not checked"
if ! docker network create --driver overlay --attachable "$ACC_NET" >"$WORK/net.out" 2>&1; then
  say "could not create the network:"
  cat "$WORK/net.out"
  u17a="skipped: the network could not be created"
else
  net_id=$(docker network inspect "$ACC_NET" --format '{{.Id}}')
  net_short=$(printf '%.12s' "$net_id")
  say "created $ACC_NET (id $net_short...), as Dockflow creates an external network: overlay, attachable"

  cat >"$WORK/a.yml" <<EOF
services:
  probe:
    image: $IMAGE
    command: ["sh", "-c", "sleep 300"]
EOF
  say ""
  say "--- A: docker stack deploy of $ACC_STACK, whose service has no network of its own ---"
  docker stack deploy -c "$WORK/a.yml" "$ACC_STACK" >"$WORK/a.out" 2>&1
  rc=$?
  say "exit code: $rc"
  say "output:"
  sed 's/^/  /' "$WORK/a.out"
  say "networks named $ACC_NET now:"
  docker network ls --no-trunc --filter "name=${ACC_NET}" --format '  {{.ID}} {{.Name}} {{.Driver}} {{.Scope}}'
  if [ "$rc" -ne 0 ]; then
    if grep -q 'already exists' "$WORK/a.out"; then
      u17a="COLLISION: docker stack deploy fails because the network already exists (exit $rc)"
    else
      u17a="FAILED for another reason (exit $rc), read the output above"
    fi
  else
    attached=$(docker service inspect "${ACC_STACK}_probe" --format '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' 2>/dev/null)
    count=$(docker network ls --filter "name=${ACC_NET}" --format '{{.Name}}' | grep -cx "$ACC_NET")
    case "$attached" in
      *"$net_short"*) u17a="NO COLLISION: the stack attached its service to the existing network" ;;
      *) u17a="NO COLLISION, but the service is not on the existing network ($count network(s) named $ACC_NET)" ;;
    esac
  fi
  say "verdict: $u17a"

  docker stack rm "$ACC_STACK" >/dev/null 2>&1
  wait_stack_gone "$ACC_STACK"

  cat >"$WORK/b.yml" <<EOF
services:
  probe:
    image: $IMAGE
    command: ["sh", "-c", "sleep 300"]
networks:
  default:
    name: $ACC_NET
    external: true
EOF
  say ""
  say "--- B: the same stack declaring that network as its external default (what Dockflow's external networks cover) ---"
  docker stack deploy -c "$WORK/b.yml" "$ACC_STACK" >"$WORK/b.out" 2>&1
  rc=$?
  say "exit code: $rc"
  say "output:"
  sed 's/^/  /' "$WORK/b.out"
  if [ "$rc" -eq 0 ]; then
    u17b="WORKS: declared as an external network, the existing network is used"
  else
    u17b="FAILS (exit $rc), read the output above"
  fi
  say "verdict: $u17b"
fi

cleanup

section "REPORT (paste the whole output)"
say "docker server: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
say "U15: $u15"
say "U17 A (implicit default network): $u17a"
say "U17 B (declared external): $u17b"
