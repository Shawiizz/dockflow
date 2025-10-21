# DevOps Automation CLI

Interactive command-line interface for setting up and managing DevOps infrastructure.

## Features

### ✨ User-Friendly Interface
- **Arrow key navigation** in all menus
- **Input validation** for IPs, ports, hostnames, and usernames
- **Contextual help** with examples and hints
- **Confirmation prompts** for destructive actions
- **Clear error messages** with suggestions

### 🔐 Server Setup
- Automated remote server configuration (Debian/Ubuntu)
- SSH key management and generation
- User creation with sudo privileges
- Docker and Portainer installation
- Nginx configuration

### 🌍 Environment Management
- Create, edit, and delete deployment environments
- View environment configurations
- Multi-host deployment support
- Input validation and safety checks

### 📋 CI/CD Integration
- GitHub Actions support
- GitLab CI support
- Automated project structure generation

## Usage

### Basic Commands

```bash
# Start interactive setup
docker run -it --rm \
  -v ${HOME}/.ssh:/root/.ssh \
  -v .:/project \
  shawiizz/devops-cli:latest

# Show help
docker run -it --rm shawiizz/devops-cli:latest --help

# Show version
docker run -it --rm shawiizz/devops-cli:latest --version
```

### Navigation

In interactive menus:
- **↑↓ Arrow keys**: Navigate options
- **Enter**: Select option
- **q**: Quit/Exit CLI

### Input Validation

The CLI validates all user inputs:

#### IP Addresses
- Format: `XXX.XXX.XXX.XXX`
- Example: `192.168.1.10`
- Each octet must be 0-255

#### Hostnames
- Valid domain format
- Example: `server.example.com`, `api.myapp.io`

#### Ports
- Range: 1-65535
- Example: `22`, `8080`, `9000`

#### Environment Names
- Lowercase alphanumeric with hyphens
- 2-50 characters
- Must start/end with letter or number
- Examples: `production`, `staging`, `dev`, `test-env`, `qa-2024`

#### Usernames
- Lowercase alphanumeric with underscores/hyphens
- 2-32 characters
- Must start with letter or underscore
- Examples: `deploy`, `admin_user`, `jenkins-ci`

## Features in Detail

### Server Setup

The CLI guides you through:

1. **Remote server information**
   - IP address or hostname (validated)
   - SSH port (default: 22)

2. **Authentication method**
   - Password authentication
   - SSH key (from file, paste, or generate new)

3. **User setup**
   - Create new deployment user
   - Or use existing user

4. **Services configuration**
   - Optional Portainer installation
   - Nginx configuration

5. **Confirmation and execution**
   - Review all settings before proceeding
   - Ansible playbook execution
   - SSH key generation and display

### Environment Management

**Add Environment**
- Guided setup with validation
- HOST and USER configuration
- Automatic file creation

**Edit Environment**
- Modify HOST or USER values
- Add/edit custom variables
- Remove variables (with protection for required fields)

**Delete Environment**
- Shows current configuration before deletion
- Confirmation prompt (destructive action)
- Removes host-specific configurations

**View Environments**
- Display all or specific environment
- Shows main and host-specific configurations
- Formatted output

### Project Setup

**New Project**
- Choose CI/CD platform (GitHub Actions or GitLab CI)
- Automatic directory structure creation:
  - `.deployment/docker/`
  - `.deployment/env/`
  - `.deployment/templates/nginx/`
  - `.deployment/templates/scripts/`
- Pre-configured `.env.production` file

**Existing Project**
- Detailed analysis display
- Environment management menu
- Easy navigation

## Safety Features

### Input Validation
All user inputs are validated before processing:
- IP addresses must be valid IPv4
- Ports must be in range 1-65535
- Environment names follow naming rules
- Usernames follow Unix conventions

### Confirmation Prompts
Destructive actions require explicit confirmation:
- Overwriting existing environments
- Deleting environments
- Proceeding with server setup

### Error Handling
- Clear error messages
- Suggested fixes
- Graceful exit on critical errors
- Logs for troubleshooting

## Examples

### Setting Up a New Server

```bash
# 1. Run the CLI
docker run -it --rm \
  -v ${HOME}/.ssh:/root/.ssh \
  -v .:/project \
  shawiizz/devops-cli:latest

# 2. Select "Setup a remote machine or modify installation"

# 3. Enter server details:
#    IP: 192.168.1.100
#    Port: 22

# 4. Choose to setup new user (recommended)

# 5. Select authentication method (password or SSH key)

# 6. Configure deployment user:
#    Username: deploy
#    Password: [secure password]

# 7. Generate SSH key for deployment

# 8. Configure services (Portainer optional)

# 9. Review and confirm

# 10. Save the displayed SSH private key!
```

### Creating an Environment

```bash
# 1. Run the CLI on your project
docker run -it --rm \
  -v ${HOME}/.ssh:/root/.ssh \
  -v .:/project \
  shawiizz/devops-cli:latest

# 2. Select "Setup a new project" or "Edit current project"

# 3. Select "Add new environment"

# 4. Enter environment details:
#    Name: staging
#    HOST: staging.example.com
#    USER: deploy

# 5. Environment created at .deployment/env/.env.staging
```

### Editing an Environment

```bash
# 1. Navigate to environment management menu

# 2. Select "Edit existing environment"

# 3. Choose environment to edit

# 4. Select what to edit:
#    - Edit HOST value
#    - Edit USER value
#    - Add/Edit custom variable
#    - Remove a variable

# 5. Make changes and confirm
```

## Tips

💡 **SSH Keys**: Always save the deployment SSH key displayed after setup. You'll need it for CI/CD configuration.

💡 **Environment Names**: Use descriptive names like `production`, `staging`, `dev` for clarity.

💡 **Multi-Host**: Create additional environment files like `.env.production.server-a` for multi-host deployments.

💡 **Validation**: The CLI prevents common mistakes by validating all inputs. Follow the examples shown.

💡 **Navigation**: Press 'q' at any time to quit the CLI safely.

## Troubleshooting

### Common Issues

**"Invalid IP address"**
- Ensure format is `XXX.XXX.XXX.XXX` (e.g., `192.168.1.10`)
- Each number must be 0-255

**"Invalid environment name"**
- Use only lowercase letters, numbers, and hyphens
- Must be 2-50 characters
- Examples: `prod`, `staging-1`, `qa-env`

**"SSH key not found"**
- Ensure the SSH directory is mounted: `-v ${HOME}/.ssh:/root/.ssh`
- Check that the key file exists and has correct permissions

**"Cannot connect to server"**
- Verify the IP address and port
- Ensure SSH is enabled on the remote server
- Check firewall rules

## Version History

See [CONTRIBUTE.md](../CONTRIBUTE.md) for version management and changelog.

## License

MIT License - See [LICENSE](../LICENSE) for details.
