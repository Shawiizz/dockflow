# Contributing Guide

This document explains how to build and maintain the Docker images used in this project.

## CI Docker Image

The `shawiizz/devops-ci:latest` image contains all the tools needed for CI operations:
- Docker
- Ansible
- NodeJS
- Docker commands extraction module

### Building the CI Image

```bash
docker build -t shawiizz/devops-ci:latest -f Dockerfile.ci .
```

### Publishing to DockerHub

```bash
docker login
docker push shawiizz/devops-ci:latest
```

## CLI Docker Image

The CLI image provides an interactive tool for server configuration.

### Building the CLI Image

```bash
docker build -t shawiizz/devops-cli:latest -f cli/Dockerfile.cli .
```

### Publishing to DockerHub

```bash
docker login
docker push shawiizz/devops-cli:latest
```

CLI tool run commands are available [there](./README.md).