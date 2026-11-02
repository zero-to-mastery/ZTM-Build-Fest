# Remediation Plan: VDE-BASE-CHOWN (Base Image Build Permissions)

## Background & Motivation
The Clan Leader requires a fully resilient "from scratch" initialization sequence where wiping `~/VDE` and `~/.ssh/vde` and then running `bin/vde path-of-the-foundling` seamlessly bootstraps the entire Forge. 

Currently, `vde init` correctly generates the new SSH keys and copies the public key to `public-ssh-keys/vde_student.pub`, triggering a mandatory re-smelt of the `vde-base` image. However, this Docker build fails with a permission error:
`chown: changing ownership of '/home/devuser/.ssh/vde/authorized_keys': Operation not permitted`

## Scope & Impact
This remediation strictly targets the foundational `vde-base.Dockerfile` (`configs/docker/vde-base.Dockerfile`). By fixing the ownership assignment during the `COPY` step, the base image will successfully re-smelt, thereby completing the `vde init` pipeline.

## Proposed Solution
The error occurs because the `Dockerfile` switches to `USER devuser` before executing the `COPY` instruction. By default, Docker assigns `root:root` ownership to files copied via the `COPY` directive unless `--chown` is explicitly used. The subsequent `RUN chown -R devuser:devuser` command fails because a non-root user (`devuser`) cannot alter the ownership of a file owned by `root`.

We will resolve this by explicitly granting `devuser:devuser` ownership during the `COPY` command.

## Alternatives Considered
An alternative is switching back to `USER root`, running the `COPY` and `chown`, and then switching to `USER devuser`. However, Docker's `COPY --chown=` directive is a more secure, standard, and elegant solution that avoids unnecessary user context switching.

## Implementation Plan
1. Edit `configs/docker/vde-base.Dockerfile`.
2. Locate the following block:
   ```Dockerfile
   COPY public-ssh-keys/vde_student.pub /home/devuser/.ssh/vde/authorized_keys
   RUN chown -R devuser:devuser /home/devuser/.ssh && \
       chmod 644 /home/devuser/.ssh/vde/authorized_keys
   ```
3. Replace it with the corrected ownership directive:
   ```Dockerfile
   COPY --chown=devuser:devuser public-ssh-keys/vde_student.pub /home/devuser/.ssh/vde/authorized_keys
   RUN chmod 644 /home/devuser/.ssh/vde/authorized_keys
   ```

## Verification
1. Run `./bin/vde rebuild base` and ensure the Docker build completes without `chown` permission errors.
2. Confirm that a simulated clean execution of `./bin/vde path-of-the-foundling` would successfully complete its three-step initiation ritual.

## Migration & Rollback
No migration is required. If the build fails for other reasons, `git checkout configs/docker/vde-base.Dockerfile` will instantly restore the previous file state.