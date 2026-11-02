# REMEDIATION PLAN: Base Image Rebuild and SSH Baking

## 1. Objective
Enforce the by-design requirement: Whenever the VDE SSH key (`vde_student`) is created or replaced, the `vde-base` image MUST be rebuilt. Additionally, ensure the public key is physically baked into the base image from the `public-ssh-keys/` directory.

## 2. Key Files & Context
- `configs/docker/vde-base.Dockerfile`: Missing the `COPY` directive to bake the key.
- `lib/vde-ssh`: Contains `sync_ssh_keys_to_vde()`, which is responsible for copying the generated key into the build context (`public-ssh-keys/`).

## 3. Implementation Steps
- **Step 1: Bake the Key**: Modify `configs/docker/vde-base.Dockerfile`. In section 5 (SSH Key Preparation), add `COPY public-ssh-keys/vde_student.pub /home/devuser/.ssh/vde/authorized_keys` and ensure proper ownership and permissions (`chmod 644`, `chown devuser:devuser`).
- **Step 2: Enforce the Rebuild Trigger**: Modify `sync_ssh_keys_to_vde()` in `lib/vde-ssh`. If a key is successfully synchronized (meaning it was created or replaced), invoke `"${VDE_ROOT_DIR}/bin/vde" rebuild base` to guarantee the new key is baked into the foundation.

## 4. Verification & Testing
- Run `bin/vde-enforce-uap.zsh` to ensure structural integrity.
- Run `bin/vde ssh-setup init --force` and verify that the base image is rebuilt successfully as part of the key regeneration process.