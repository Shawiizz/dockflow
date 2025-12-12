#!/bin/bash
# Test post-build hook
echo "HOOK_TEST: post-build executed for {{ project_name }} version {{ version }}"
echo "post-build" > /tmp/dockflow-hook-post-build.txt
