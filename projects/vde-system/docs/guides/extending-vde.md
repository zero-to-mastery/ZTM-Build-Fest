# EXTENDING-VDE
<!-- @shared-law (Sovereign Law) -->
# Extending VDE (1.5.5)

VDE is designed to be easily extensible. You can add support for new programming languages or services by updating the **Beskar Registry** and creating hydration scripts.

[← Back to README](../../README.md)

---

## Adding New Languages

### Step 1: Update the Registry
Add the new definition to `data/vm-types.conf` using the 8-field standard:
`type|name|aliases|display|pkgs|custom_cmd|service_ports|ssh_port`

**Example (Zig):**
```zsh
vde add --pkgs "zig-sdk" zig
```

### Step 2: Create the Hydration Script
Create `scripts/setup/zig-init.zsh`. It MUST be ZSH-only and end with a cleanup ritual:

```zsh
#!/usr/bin/env zsh
set -e
# Install Zig...
apt-get update && apt-get install -y zig
# Purge the Ghosts (Mandatory)
apt-get clean && rm -rf /var/lib/apt/lists/*
```

### Step 3: Ignite
```zsh
vde start zig
```

---

## What Just Happened?

When a new Spoke is created:
1. **Config Smelted**: `configs/docker/<alias>/docker-compose.yml` is rendered.
2. **Identity Baked**: The `vde_student` public key is synced to the build context.
3. **SSH Entry Added**: `~/.ssh/vde/config` is updated:
   ```text
   Host vde-zig
     HostName localhost
     Port <assigned_port>
     User devuser
     IdentityFile ~/.ssh/vde/vde_student
   ```

---

## Template Extension

You can modify the base templates in `templates/` to change how all Spokes are built. 
- **`compose-language.yml`**: Controls volume mapping for `$HOME/workspace/`.
- **`compose-service.yml`**: Controls volume mapping for `data/`.

**Caution**: Modifications to templates require a `vde rebuild all` to propagate.

---

[← Back to README](../../README.md)
**This is the Way.**
