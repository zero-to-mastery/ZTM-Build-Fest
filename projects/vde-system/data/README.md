# VDE VM Types Configuration
<!-- @armor (Registry Documentation) -->

This directory contains the VM type configuration for the VDE system.

## Files

### vm-types.json

Main configuration file defining all supported VM types. This is the **single source of truth** for VM configuration.

**Structure:**
- `version`: Configuration schema version
- `vms.language[]`: Development language VMs (Python, JavaScript, etc.)
- `vms.service[]`: Infrastructure service VMs (PostgreSQL, Redis, etc.)

**Example:**
```json
{
  "version": "1.0",
  "vms": {
    "language": [
      {
        "name": "python",
        "aliases": ["python3", "py"],
        "display": "Python",
        "install": "apt-get update -y && apt-get install -y python3 python3-pip",
        "port": null
      }
    ],
    "service": [
      {
        "name": "postgres",
        "aliases": ["postgresql", "pg"],
        "display": "PostgreSQL",
        "install": "apt-get update -y && apt-get install -y postgresql-client",
        "port": "5432"
      }
    ]
  }
}
```

### vm-types.schema.json

JSON Schema defining validation rules for `vm-types.json`. Ensures configuration integrity.

**Validation rules:**
- **Language VMs** must have: `name`, `display`, `install`, `port: null`
- **Service VMs** must have: `name`, `display`, `install`, `port: "string"`
- Names must match pattern: `^[a-z0-9]+$`
- Service ports must match pattern: `^[0-9]+(,[0-9]+)*$`

**Usage:**
```zsh
# Validate configuration (automatic during vm-common loading)
python3 -c "
import json
with open('vm-types.schema.json') as f: schema = json.load(f)
with open('vm-types.json') as f: data = json.load(f)
# Validation happens in vm-common load_vm_types()
"
```

### vm-types.conf (Legacy)

**⚠️ DEPRECATED:** Legacy configuration format. Use `vm-types.json` instead.

This file is maintained for backward compatibility but will be removed in a future version.

## Field Definitions

### Static Configuration Fields

These fields are defined in `vm-types.json` and loaded by all VDE libraries:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | VM identifier (lowercase alphanumeric). Used for container naming, SSH config, directories. |
| `aliases` | string[] | optional | Alternative names for user convenience (e.g., `["py", "python3"]`). |
| `display` | string | ✓ | Human-readable name for UI/logging (e.g., `"Python"`, `"PostgreSQL"`). |
| `install` | string | ✓ | Shell command for container provisioning. Runs as root during VM setup. |
| `port` | null/string | ✓ | Service port(s). `null` for language VMs, comma-separated string for service VMs (e.g., `"80,443"`). |

### Runtime State (NOT in schema)

These are managed separately by VDE and NOT part of `vm-types.json`:

| Field | Storage | Description |
|-------|---------|-------------|
| `ssh_port` | `.cache/port-registry/{name}.port` | Dynamically allocated host port for SSH access. |
| `container_name` | Derived: `{name}-dev` (lang) or `{name}` (service) | Docker container identifier. |
| `status` | Queried: `docker ps` | Container running/stopped state. |
| `ssh_configured` | Checked: `~/.ssh/vde/config` | SSH config entry exists. |

## VM Type Categories

### Language VMs

**Purpose:** Development environments for programming languages.

**Characteristics:**
- Container name: `{name}-dev`
- SSH port: Dynamically allocated
- Service ports: None (`port: null`)
- Example: Python, JavaScript, Ruby, Go

**Minimal "Running and Accessible" Requirements:**
1. **Static config** (in `vm-types.json`): `name`, `display`, `install`
2. **Runtime state**: SSH port allocated, container running, SSH config created

### Service VMs

**Purpose:** Infrastructure services (databases, message queues, web servers).

**Characteristics:**
- Container name: `{name}` (no `-dev` suffix)
- SSH port: Dynamically allocated
- Service ports: Defined in `port` field (e.g., `"5432"`, `"80,443"`)
- Example: PostgreSQL, Redis, Nginx, RabbitMQ

**Minimal "Running and Accessible" Requirements:**
1. **Static config** (in `vm-types.json`): `name`, `display`, `install`, `port`
2. **Runtime state**: SSH port allocated, container running, service ports exposed, SSH config created

## Schema Validation

Schema validation is **automatic** when loading VM types via `vm-common`:

```zsh
source lib/vm-common
load_vm_types  # Validates against schema automatically
```

**Manual validation:**

```zsh
# Python validation
python3 -c "
import json
with open('data/vm-types.schema.json') as f:
    schema = json.load(f)
with open('data/vm-types.json') as f:
    data = json.load(f)
# Basic checks
assert 'version' in data and 'vms' in data
assert 'language' in data['vms'] and 'service' in data['vms']
for vm in data['vms']['language']:
    assert all(k in vm for k in ['name', 'display', 'install'])
    assert vm.get('port') is None
for vm in data['vms']['service']:
    assert all(k in vm for k in ['name', 'display', 'install', 'port'])
print('✓ Schema validation passed')
"

# Unit tests
tests/unit/vm-types-schema.test.zsh
```

## Adding New VM Types

### Language VM

```json
{
  "name": "kotlin",
  "aliases": ["kt"],
  "display": "Kotlin",
  "install": "apt-get update -y && apt-get install -y kotlin",
  "port": null
}
```

Add to `vms.language[]` array in `vm-types.json`.

### Service VM

```json
{
  "name": "mongodb",
  "aliases": ["mongo"],
  "display": "MongoDB",
  "install": "apt-get update -y && apt-get install -y mongodb-org-shell",
  "port": "27017"
}
```

Add to `vms.service[]` array in `vm-types.json`.

### Validation after changes

```zsh
# Validate schema
python3 -c "import json; json.load(open('data/vm-types.json'))"

# Run unit tests
tests/unit/vm-types-schema.test.zsh

# Test loading in vm-common
zsh -c "source lib/vde-core && source lib/vm-common && load_vm_types"
```

## Design Principles

1. **Separation of Concerns**: Static config (vm-types.json) separate from runtime state (port registry, Docker state)
2. **Single Source of Truth**: `vm-types.json` is the authoritative VM configuration
3. **Schema Validation**: Automatic validation prevents configuration errors
4. **Type Discrimination**: VM type inferred from array membership (`language[]` vs `service[]`)
5. **Minimal Fields**: Only fields needed for provisioning, startup, and SSH access

## Implementation Details

**Shell access** (`vm-common`):
```zsh
source lib/vm-common
load_vm_types

# Access VM data via associative arrays:
echo "${VM_TYPE[python]}"      # "lang"
echo "${VM_DISPLAY[python]}"   # "Python"
echo "${VM_INSTALL[python]}"   # "apt-get update..."
echo "${VM_SVC_PORT[postgres]}" # "5432"
```

**Python access**:
```python
import json
with open('data/vm-types.json') as f:
    config = json.load(f)

# Access language VMs
for vm in config['vms']['language']:
    print(f"{vm['name']}: {vm['display']}")

# Access service VMs
for vm in config['vms']['service']:
    print(f"{vm['name']} on port {vm['port']}")
```

## Testing

**Unit tests:** `tests/unit/vm-types-schema.test.zsh`

Coverage:
- Schema file structure validation
- Required field validation (language and service VMs)
- Port field validation (null for lang, string for service)
- Name pattern validation (lowercase alphanumeric)
- Service port pattern validation (comma-separated integers)

**Run tests:**
```zsh
tests/unit/vm-types-schema.test.zsh
# Expected: 10 passed, 0 failed
```
