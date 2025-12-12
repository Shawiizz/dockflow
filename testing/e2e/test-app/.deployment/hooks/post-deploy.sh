#!/bin/bash
# Test post-deploy hook
echo "HOOK_TEST: post-deploy executed for {{ project_name }} version {{ version }}"
echo "post-deploy:{{ version }}" > /tmp/dockflow-hook-post-deploy.txt
