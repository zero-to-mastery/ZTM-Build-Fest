# VSCode Remote-SSH
<!-- @shared-law (Sovereign Law) -->

Using VSCode Remote-SSH with VDE in the **Sovereign Baseline (1.5.5)**.

[← Back to README](../../README.md)

---

## Setup

### 1. Install the Extension

Install the [Remote-SSH extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)

### 2. Connect to Host

1. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
2. Type "Remote-SSH: Connect to Host"
3. Select your VM (e.g., `vde-python`, `vde-rust`, `postgres`)

### 3. Open Your Project

```zsh
File > Open Folder > $HOME/workspace/
```

---

## Recommended VSCode Extensions

Install these extensions inside your VMs for the best experience:

### Language-Specific

| Language | Extensions |
|----------|------------|
| Python | Python, Pylance |
| Rust | rust-analyzer |
| Go | Go |
| JavaScript/TypeScript | ESLint, Prettier |
| C/C++ | C/C++ |
| Java | Extension Pack for Java |

### General

- GitLens
- Docker
- Remote - SSH
- Remote - SSH: Editing Configuration Files

---

## VSCode Workflow

1. **Connect** to VM via Remote-SSH
2. **Open** your project: `File > Open Folder > $HOME/workspace/`
3. **Edit** files with full IDE support
4. **Run** tests using the integrated terminal
5. **Debug** using VSCode's debugger

---

## Tips

- **Use the integrated terminal** for running commands inside the container
- **Extensions install automatically** when you first connect
- **Files sync in real-time** via the volume mount from your host
- **Multiple connections** - You can have multiple VMs open at once

---

[← Back to README](../../README.md)
