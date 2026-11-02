# VDE VM Docker Configuration
<!-- @shared-law (Sovereign Law) -->

> **NOTE**: This document describes the conceptual Docker configuration system. The VDE uses dynamic configuration generation from `data/vm-types.json` and template files in `templates/` rather than a static `vm-docker-config.json` file.

## Overview

The VM Docker configuration system provides:
- **Centralized settings** for all language and service VMs
- **Dynamic compose file** generation from templates
- **Environment file** paths
- **Container naming** conventions
- **Volume mount** configurations
- **Automatic validation** against JSON schema

## Configuration Source

**Authority:** `data/vm-types.json`

The Beskar Registry (`data/vm-types.json`) is the single source of truth for VM definitions. Each VM entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique VM identifier (e.g., `vde-python`) |
| `aliases` | array | Alternative names for user convenience |
| `display` | string | Human-readable name |
| `pkgs` | string | Required system packages (empty for build-time) |
| `custom_cmd` | string | Initialization/hydration script path |
| `service_ports` | string | Service port(s) for service VMs |
| `ssh_port` | integer | SSH port assignment |

## Docker Build System

### Base Images

- **vde-base**: Foundational image with Zsh, Git, Docker CLI, SSH, socat
- **vde-lang**: Language VM image (inherits from vde-base, uses build args for packages)

**Location:** `configs/docker/`

### Configuration Files

| File | Purpose |
|------|---------|
| `configs/docker/vde-base.Dockerfile` | Base image with core tools |
| `configs/docker/vde-lang.Dockerfile` | Language VM image with build-time package installation |
| `env-files/*.env` | Per-VM environment variables |

### Container Naming

- Language VMs: `vde-<alias>` (e.g., `vde-python`)
- Service VMs: `vde-<alias>` (e.g., `vde-postgres`)

### Volume Mounts

- **Workspace**: `projects/<alias>:$HOME/workspace/` (language VMs)
- **Data**: `data/<alias>:/data` (service VMs)
- **Logs**: `logs/<alias>:/logs` (all VMs)
- **SSH Agent**: Host socket mounted read-only

## Usage

### Load VM Types

```zsh
source "${VDE_ROOT_DIR}/lib/vm-common"
load_vm_types
```

### Access VM Configuration

```zsh
# Get VM SSH port
get_vm_ssh_port "python"
# Output: 2217

# Get VM hydration script
vde_get_hydration_script "python"
# Output: zsh /vde/scripts/setup/python-init.zsh

# Resolve VM name from alias
resolve_vm_name "py"
# Output: python
```

### Validate Configuration

```zsh
# Validate Beskar Registry against schema
vde validate
```

## Validation Rules

### Language VMs
- Must have unique name and SSH port in 2200–2299 range
- Must have a corresponding hydration script in `scripts/setup/`
- Container name: `vde-<name>`

### Service VMs
- Must have unique name and SSH port in 2400–2499 range
- Must have `service_ports` defined
- Must have a corresponding hydration script in `scripts/setup/`
- Container name: `vde-<name>`

## File Structure

```
VDE Project Root
├── data/
│   ├── vm-types.json              # VM metadata (AUTHORITY)
│   └── vm-types.schema.json       # VM types schema
├── configs/docker/
│   ├── vde-base.Dockerfile        # Base image
│   ├── vde-lang.Dockerfile        # Language VM image
│   ├── python/
│   │   └── docker-compose.yml     # Generated compose file
│   └── ...
├── env-files/
│   ├── python.env                 # Per-VM environment
│   └── ...
└── scripts/setup/
    ├── python-init.zsh            # Hydration ritual
    └── ...
```

## Integration with VM Types

**vm-types.json** provides the complete VM configuration:
- VM metadata (name, display, aliases)
- Service ports
- VM type (lang/service)
- SSH port assignment
- Hydration script path

## Adding New VMs

Use the `vde add` command to register new VM types:

```zsh
# Add a language VM
vde add --pkgs "htop,tree" my-custom-vm

# Add a service VM with specific ports
vde add --type service --port 5000 my-api
```

### Validation After Changes

```zsh
# Validate schema
vde validate

# Force cache re-smelt
vde rebuild-cache
```

## Troubleshooting

### "Schema validation failed"

**Cause**: vm-types.json doesn't match schema

**Solution**:
1. Check JSON syntax
2. Verify required fields present
3. Check naming patterns and port ranges
4. Run validation: `vde validate`

### "VM not found"

**Cause**: VM not in vm-types.json

**Solution**:
1. Check VM exists: `vde list`
2. Add VM if missing: `vde add <name>`
3. Rebuild cache: `vde rebuild-cache`

## References

- **JSON Schema Spec**: https://json-schema.org/
- **VM Types Config**: `data/vm-types.json`
- **Schema Validation**: `vde validate`
- **VM Type Library**: `lib/vm-common`
