# Contributing Guide

This document explains how to contribute to this project and build/maintain the Docker images.

I did this project alone, if you want a new functionnality, you can open an issue or open a pull request :)     

> **IMPORTANT**: When pushing a new tag/release, use the automated version manager to update all version references:
> ```bash
> npm run version:release      # For stable releases
> npm run version:dev          # For development versions
> npm run version:downgrade    # To revert version changes
> npm run ci-image:release     # For CI Docker image stable releases
> npm run ci-image:dev         # For CI Docker image development versions
> npm run ci-image:downgrade   # To revert CI image version changes
> ```
> The script automatically updates version references in example files and CI scripts. You can also manually verify updates in:
> - `.gitlab/common/build-steps.yml`
> - `.gitlab/workflows/*.yml`
> - `example/ci/*.yml`

## CI Docker Image

The `shawiizz/dockflow-ci:latest` image contains all the tools needed for CI operations:
- Docker
- Ansible
- NodeJS
- Docker commands extraction module

### Building the CI Image

```bash
docker build --no-cache -t shawiizz/dockflow-ci:latest -f Dockerfile.ci .
docker build --no-cache -t shawiizz/dockflow-ci:1.0.5 -f Dockerfile.ci .
```

### Publishing to DockerHub

```bash
docker login
docker push shawiizz/dockflow-ci:latest
docker push shawiizz/dockflow-ci:1.0.5
```

## CLI Docker Image

The CLI image provides an interactive tool for server configuration.

### Building the CLI Image

For Windows users, make sure all `.sh` files are in `LF` mode and not `CRLF`.       

```bash
docker build -t shawiizz/dockflow-cli:latest -f cli/Dockerfile.cli .
```

### Publishing to DockerHub

```bash
docker login
docker push shawiizz/dockflow-cli:latest
```

CLI tool run commands are available [there](./README.md).

## Version Management

This project includes an automated version management system that handles version increments and updates across all project files.

### Available Commands

**Framework Version:**
- **`npm run version:dev`** - Adds or increments development version
  - `1.0.33` → `1.0.33-dev1`
  - `1.0.33-dev1` → `1.0.33-dev2`

- **`npm run version:release`** - Creates release version
  - `1.0.33-dev1` → `1.0.40-dev2`
  - `1.0.33` → `1.0.40-dev2`

- **`npm run version:downgrade`** - Decrements version
  - `1.0.33-dev3` → `1.0.33-dev2`
  - `1.0.33-dev1` → `1.0.33` (removes dev)

**CI Docker Image Version:**
- **`npm run ci-image:dev`** - Adds or increments CI Docker image development version
  - `1.0.4` → `1.0.4-dev1`
  - `1.0.4-dev1` → `1.0.4-dev2`

- **`npm run ci-image:release`** - Creates CI Docker image release version
  - `1.0.4-dev1` → `1.0.5`
  - `1.0.4` → `1.0.5`

- **`npm run ci-image:downgrade`** - Decrements CI Docker image version
  - `1.0.4-dev2` → `1.0.4-dev1`
  - `1.0.4-dev1` → `1.0.4` (removes dev)
  - `1.0.4` → `1.0.3`

### What Gets Updated

**Framework Version Management:**
- `package.json` version field
- All `.yml` and `.yaml` files (CI/CD configurations)
- Example files in `example/ci/`
- GitLab workflow files
- Other project configuration files (excludes Docker image references)

**CI Docker Image Version Management:**
- `package.json` ciImageVersion field
- Docker image references (`shawiizz/dockflow-ci:X.Y.Z`)
- CI configuration files that use the Docker image

## Creating New Releases

When creating a new release and pushing a new tag, follow these steps:

1. **Update all version references** in the repository using the automated version manager:
   ```bash
   # Framework version management
   npm run version:dev       # For development versions
   npm run version:release   # For release versions
   npm run version:downgrade # To downgrade version
   
   # CI Docker image version management (separate from framework)
   npm run ci-image:dev        # For CI Docker development versions
   npm run ci-image:release    # For CI Docker release versions
   npm run ci-image:downgrade  # To downgrade CI image version
   ```
    
2. **Update the Docker image tags** if needed:
   ```bash
   # For CI image
   docker build -t shawiizz/dockflow-ci:X.Y.Z -f Dockerfile.ci .
   docker tag shawiizz/dockflow-ci:X.Y.Z shawiizz/dockflow-ci:latest
   docker push shawiizz/dockflow-ci:X.Y.Z
   docker push shawiizz/dockflow-ci:latest
   
   # For CLI image
   docker build -t shawiizz/dockflow-cli:X.Y.Z -f cli/Dockerfile.cli .
   docker tag shawiizz/dockflow-cli:X.Y.Z shawiizz/dockflow-cli:latest
   docker push shawiizz/dockflow-cli:X.Y.Z
   docker push shawiizz/dockflow-cli:latest
   ```

3. **Create the new tag** and push it:
   ```bash
   git tag -a X.Y.Z -m "Version X.Y.Z"
   git push origin X.Y.Z
   ```

This ensures that all references to the repository and Docker images are updated consistently.

## License

By contributing to this project, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).