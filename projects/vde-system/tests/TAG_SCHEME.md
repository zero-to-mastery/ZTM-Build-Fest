# VDE Test Tagging Scheme
<!-- @forge (Governance Sentinel) -->

## Fast Tests (No Docker Required)

| Tag | Description | Run Command |
|-----|-------------|-------------|
| `@parser` | Natural language parser tests | `behave --tags=@parser` |
| `@spec` | Spec invariant tests | `behave --tags=@spec` |
| `@config` | Config generation tests (SSH, docker-compose) | `behave --tags=@config` |
| `@error-path` | Error handling tests | `behave --tags=@error-path` |

Run all fast tests: `behave --tags=@parser,@spec,@config,@error-path`

## Integration Tests (Require Docker)

| Tag | Description | Run Command |
|-----|-------------|-------------|
| `@integration` | All Docker-requiring tests | `behave --tags=@integration` |

### Integration Sub-tags

| Tag | Description |
|-----|-------------|
| `@vm-lifecycle` | create/start/stop/remove VMs |
| `@vm-rebuild` | rebuild --no-cache tests |
| `@ssh-access` | SSH into running VMs |
| `@networking` | VM-to-VM communication |
| `@storage` | volume/data tests |

## Usage Examples

```zsh
# Run only fast tests (no Docker)
behave --tags=@parser,@spec,@config,@error-path

# Run all integration tests
behave --tags=@integration

# Run only VM lifecycle integration tests
behave --tags=@vm-lifecycle

# Run parser + integration tests
behave --tags=@parser,@integration

# Exclude integration tests
behave --tags=-@integration
```

## Tag Hierarchy

```
@parser     → Fast, no Docker
@spec       → Fast, no Docker
@config     → Fast, no Docker
@error-path → Fast, no Docker

@integration (umbrella)
  ├── @vm-lifecycle
  ├── @vm-rebuild
  ├── @ssh-access
  ├── @networking
  └── @storage
```
