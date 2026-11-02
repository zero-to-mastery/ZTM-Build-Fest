# Advanced Usage
<!-- @shared-law (Sovereign Law) -->

Advanced techniques and patterns for power users in the **Sovereign Baseline**.

[← Back to README](../../README.md)

---

## Custom Installation Commands

### Multi-Step Installation

```zsh
# Download and install from URL
    "apt-get update && apt-get install -y wget && \
```

### Install as devuser

```zsh
# Rust-style installers
vde create rust \
    "su devuser -c 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y'"
```

---

## Multiple Service Ports

```zsh
# For services with multiple ports
vde create --type service --svc-port 80,443 nginx \
    "apt-get update -y && apt-get install -y nginx-extras"
```

---

## Custom Display Names

```zsh
# Override the auto-generated display name
vde create --display "Rust Programming Language" rust \
    "apt-get update -y && apt-get install -y rustc"
```

---

## Environment-Specific Installations

```zsh
vde create python \
    "apt-get update -y && apt-get install -y python3 python3-pip && \
     if [ \"\${VDE_PYTHON_VERSION:-latest}\" = \"3.11\" ]; then \
       apt-get install -y python3.11 python3.11-venv; \
     else \
       apt-get install -y python3.12 python3.12-venv; \
     fi"
```

Then in `env-files/python.env`:
```zsh
VDE_PYTHON_VERSION=3.11
```

---

## Custom Base Images

If a language needs a different base OS:

1. Create a new Dockerfile: `configs/docker/custom-base.Dockerfile`
2. Modify the template to use it:

**Edit `templates/compose-language.yml`:**
```yaml
services:
  {{NAME}}-dev:
    build:
      context: ../../..
      dockerfile: configs/docker/custom-base.Dockerfile
```

---

## Post-Installation Scripts

```zsh
vde create dotnet \
    "apt-get update -y && apt-get install -y wget apt-transport-https && \
     wget https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O /tmp/packages-microsoft-prod.deb && \
     dpkg -i /tmp/packages-microsoft-prod.deb && rm /tmp/packages-microsoft-prod.deb && \
     apt-get update -y && apt-get install -y dotnet-sdk-8.0 aspnetcore-runtime-8.0 && \
     su devuser -c 'dotnet tool install --global dotnet-format'"
```

---

## Alias Management

Create composite VMs by adding aliases:

```zsh
# In vm-types.conf
lang|js|node,nodejs,typescript|JavaScript|apt-get update && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && npm install -g typescript|

# Now both create the same VM:
vde create js
vde create typescript
```

---

## Docker Compose Overrides

For custom container configurations, you can add overrides to the docker-compose.yml after creation:

```yaml
# configs/docker/python/docker-compose.yml (after creation)
services:
  vde-python:
    # ... existing config ...
    environment:
      - CUSTOM_VAR=value
    volumes:
      - ./custom-mount:/custom/path
```

---

## Inter-Container Communication

All containers share the `vde-net` Docker network and have SSH agent forwarding enabled.

### VM-to-VM Communication via SSH

With SSH agent forwarding, you can SSH between VMs using your host's SSH keys:

```zsh
# From Go VM, connect to Python VM
ssh vde-go
ssh vde-python                # Uses your host's SSH keys!
ssh vde-python pwd            # Run command on Python VM
scp vde-python:/data/file .   # Copy file from Python VM
```

### Full Stack Development

```zsh
# Create a full stack: API, database, cache
vde create python postgres redis
vde start python postgres redis

# From Python VM (API layer)
ssh vde-python
ssh vde-postgres psql -U devuser -c "SELECT * FROM users"
ssh vde-redis redis-cli INCR counter
```

### Microservices Architecture

```zsh
# Create microservices
vde create go python rust postgres
vde start go python rust postgres

# From Go VM (API gateway)
ssh vde-go
# Call other services
ssh vde-python svc_status
ssh vde-rust analytics
ssh vde-postgres "psql -c 'SELECT COUNT(*) FROM orders'"
```

### Service Mesh Pattern

```zsh
# Create service mesh
vde create nginx go python postgres redis
vde start nginx go python postgres redis

# From Nginx VM (edge router)
ssh vde-nginx
# Proxy requests to backend services
curl http://vde-go:8080/health
curl http://vde-python:8000/api/status
```

### Using Host Communication

Execute commands on your host from within any VM:

```zsh
# From within any VM
to-host ls ~/dev                    # List host's dev directory
to-host docker ps                   # Check host's containers
to-host tail -f logs/app.log        # View host's log files
```

### Git Operations from VMs

Use your host's SSH keys for Git operations from within any VM:

```zsh
# From within any VM
git clone github.com:user/repo      # Uses your GitHub key
git push origin main                # Authentication works automatically
```

---

[← Back to README](../../README.md)
