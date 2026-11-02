# ADR-003: Born Ready Containers
<!-- @forge (Context Documentation) -->

**Status**: Accepted  
**Date**: 2026-04-30  
**Context**: Immutability requirement for container images

---

## Context

VDE containers (Spokes) are intended to be immutable, reproducible development environments. The traditional approach of running `apt-get install` or other package managers at container startup introduces several problems:

1. **Network Dependency**: Container startup fails without network access or when package repositories are unavailable
2. **Non-Determinism**: Different runs of the same container may have different installed packages (repository updates, version changes)
3. **Slow Startup**: Package installation adds significant time to container initialization
4. **Configuration Drift**: Runtime installations create differences between development, testing, and production environments
5. **Image Invalidation**: Runtime changes cannot be captured in version-controlled Docker images
6. **Audit Trail Loss**: No record of what packages are installed or when

VDE's governance framework requires that containers be fully functional at image creation time, with all dependencies baked in and no reliance on external systems during runtime.

---

## Decision

VDE SHALL enforce the "Born Ready" (BTO) principle: every Spoke container MUST be fully functional immediately upon image creation. All package installation, configuration, and setup occurs during `docker build` phase. Runtime `apt` calls and network-dependent configurations are strictly prohibited.

### Technical Implementation

1. **Build-Time Installation**: All packages listed in `vm-types.conf` `pkgs` field are installed in Dockerfile
2. **Configuration Baking**: All configuration files are created and customized during build
3. **Script Inclusion**: Setup scripts from `scripts/setup/<alias>-init.zsh` are copied into image
4. **Service Startup**: Required services are configured to start automatically via entrypoint
5. **Cache Purging**: `apt-get clean` and `rm -rf /var/lib/apt/lists/*` executed after installation

### Universal Script Parity (USP)

Every VM type has a corresponding initialization script:
```
scripts/setup/<alias>-init.zsh
```

This script is:
- Copied into the container during build
- Executed on first container start via entrypoint
- Uses absolute `/vde/` paths for reliability
- Performs all runtime configuration without network calls

---

## Alternatives Considered

### Alternative 1: Runtime Package Installation
**Rejected**:
- Introduces network dependency (violates immutability)
- Non-deterministic package versions (repository updates)
- Slow container startup
- No image-level versioning of installed packages
- Breaks offline development capability

### Alternative 2: Layered Caching with Runtime Checks
**Rejected**:
- Still requires runtime network calls for package updates
- Cache invalidation logic adds complexity
- Doesn't solve the fundamental immutability problem
- Difficult to audit and validate

### Alternative 3: Separate Base Images with Runtime Composition
**Rejected**:
- Increases image storage and build time
- Complex dependency management between layers
- Still allows runtime modifications
- Defeats the purpose of single immutable artifact

### Alternative 4: Live Patching and Hot Reloading
**Rejected**:
- Antithetical to immutability principle
- Impossible to audit and validate
- Creates configuration drift
- Production security nightmare

---

## Consequences

### Positive Outcomes

1. **Immutability**: Container images are version-controlled, reproducible artifacts
2. **Offline Capability**: Containers work without network access after initial pull
3. **Fast Startup**: No package installation delays during container initialization
4. **Determinism**: Same image produces identical behavior every time
5. **Audit Trail**: All installed packages recorded in Dockerfile and version control
6. **Security**: No runtime package manager execution reduces attack surface
7. **Reproducibility**: Exact same environment can be reproduced by anyone with the image

### Negative Outcomes

1. **Larger Images**: All dependencies baked in increases image size
2. **Longer Builds**: Build time includes all package installation
3. **Update Complexity**: Package updates require rebuilding images
4. **Disk Usage**: Multiple VM types consume more disk space
5. **Version Bloat**: Old image versions accumulate if not pruned

### Mitigation Strategies

1. **Multi-Stage Builds**: Use multi-stage Dockerfiles to minimize final image size
2. **Base Image Strategy**: Shared base images for common dependencies
3. **Build Caching**: Leverage Docker layer caching for faster rebuilds
4. **Image Pruning**: `vde prune.zsh` removes unused images and caches
5. **Version Strategy**: Frequent, small updates rather than infrequent large changes

---

## Related Decisions

- **ADR-001**: ZSH-Only Requirement - Both enforce deterministic behavior
- **ADR-002**: SSH Bridge Architecture - Service configured at build time
- **UAP Enforcement**: Born Ready violations detected by sentinel

---

## Implementation Details

### Dockerfile Pattern
```dockerfile
# Base image with Zsh
FROM ubuntu:22.04

# Install Zsh (only runtime dependency)
RUN apt-get update && \
    apt-get install -y zsh git openssh-server && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy setup scripts
COPY scripts/setup/<alias>-init.zsh /vde/setup/

# Install all packages from vm-types.conf
RUN apt-get update && \
    apt-get install -y <package1> <package2> ... && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Setup devuser
RUN useradd -m -s /usr/bin/zsh devuser

# SSH setup
RUN mkdir -p /home/devuser/.ssh && \
    chown devuser:devuser /home/devuser/.ssh

# Entrypoint
COPY scripts/vde-entrypoint.zsh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/vde-entrypoint.zsh"]
```

### USP Script Pattern
```zsh
#!/usr/bin/env zsh
# @armor (Spoke Initialization)

# All paths absolute for reliability
VDE_MOUNT="/vde"
SETUP_SCRIPT="${VDE_MOUNT}/setup/<alias>-init.zsh"

# Check if already initialized
if [[ ! -f "${HOME}/.vde-initialized" ]]; then
    source "${SETUP_SCRIPT}"
    touch "${HOME}/.vde-initialized"
fi
```

---

## References

- `docs/architecture/data-flow.md` - Born Ready (BTO) section
- `lib/vde-docker` - Container build and management
- `scripts/vde-entrypoint.zsh` - Container entrypoint
- `bin/vde-rebuild` - Container rebuild command
- `docs/vm-docker-config.md` - VM Docker configuration guide

---

**This is the Way.**
