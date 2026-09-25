#!/bin/sh
# E-36-13: records the remote hook environment (design-06/services/hook.ts hookEnvironment, K33 (f))
# and proves DOCKFLOW_KUBECTL/DOCKFLOW_NAMESPACE actually reach the cluster, without printing anything
# the CLI output would carry (this hook never fails the deploy: hooks are non-fatal by default).
set -eu
out="$HOME/e2e-hook-output-$DOCKFLOW_VERSION.txt"
{
  echo "DOCKFLOW_ORCHESTRATOR=$DOCKFLOW_ORCHESTRATOR"
  echo "DOCKFLOW_NAMESPACE=$DOCKFLOW_NAMESPACE"
  echo "DOCKFLOW_STACK=$DOCKFLOW_STACK"
  echo "DOCKFLOW_VERSION=$DOCKFLOW_VERSION"
  echo "KUBECONFIG=$KUBECONFIG"
  echo "DOCKFLOW_KUBECTL=$DOCKFLOW_KUBECTL"
  echo "PWD=$(pwd)"
} > "$out"
if $DOCKFLOW_KUBECTL get ns "$DOCKFLOW_NAMESPACE" >/dev/null 2>&1; then
  echo "NS_OK=1" >> "$out"
else
  echo "NS_OK=0" >> "$out"
fi
