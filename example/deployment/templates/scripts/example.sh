#!/bin/bash

echo "Executing script on {{ ansible_hostname }}"
echo "Distribution: {{ ansible_distribution }} {{ ansible_distribution_version }}"

echo "Docker processes list:"
docker ps