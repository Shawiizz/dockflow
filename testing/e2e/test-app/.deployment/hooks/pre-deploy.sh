#!/bin/bash
# Test pre-deploy hook
echo "HOOK_TEST: pre-deploy executed for {{ project_name }} version {{ version }}"
echo "pre-deploy:{{ version }}" > /tmp/dockflow-hook-pre-deploy.txt
