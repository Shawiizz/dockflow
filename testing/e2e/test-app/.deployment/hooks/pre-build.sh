#!/bin/bash
# Test pre-build hook
echo "HOOK_TEST: pre-build executed for {{ project_name }} version {{ version }}"
echo "pre-build" > /tmp/dockflow-hook-pre-build.txt
