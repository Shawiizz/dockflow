# Contributing Guide

This document explains how to build and maintain the Docker images used in this project.

> **IMPORTANT**: When pushing a new tag/release, remember to update all version references in example files and CI scripts to ensure users download the correct version. Particularly update tag references in:
> - `.gitlab/ci-templates/build-steps.yml`
> - `.gitlab/workflows/*.yml`
> - `example/ci/*.yml`

You can search for the latest tag version using your IDE's search bar and bulk edit the version to the next tag verison you plan to publish.

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

## Creating New Releases

When creating a new release and pushing a new tag, follow these steps:

1. **Update all version references** in the repository:
   ```bash
   # Find all files with version references (powershell command, otherwise use your IDE\'s search bar)
   Get-ChildItem -Path . -Recurse -Include "*.yml","*.yaml" | Select-String -Pattern "refs/tags/[0-9]" | Select-Object Path,LineNumber,Line | Format-Table -Wrap
   
   # After identifying files, update them with the new version number

   For CI image, search for shawiizz/devops-ci (or you own image if you edited it) and update the version if you updated the image.
   ```

2. **Update the Docker image tags** if needed:
   ```bash
   # For CI image
   docker build -t shawiizz/devops-ci:X.Y.Z -f Dockerfile.ci .
   docker tag shawiizz/devops-ci:X.Y.Z shawiizz/devops-ci:latest
   docker push shawiizz/devops-ci:X.Y.Z
   docker push shawiizz/devops-ci:latest
   
   # For CLI image
   docker build -t shawiizz/devops-cli:X.Y.Z -f cli/Dockerfile.cli .
   docker tag shawiizz/devops-cli:X.Y.Z shawiizz/devops-cli:latest
   docker push shawiizz/devops-cli:X.Y.Z
   docker push shawiizz/devops-cli:latest
   ```

3. **Create the new tag** and push it:
   ```bash
   git tag -a X.Y.Z -m "Version X.Y.Z"
   git push origin X.Y.Z
   ```

This ensures that all references to the repository and Docker images are updated consistently.