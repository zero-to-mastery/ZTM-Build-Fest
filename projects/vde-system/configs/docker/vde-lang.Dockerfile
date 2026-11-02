# VDE ARCHITECTURAL RECORD
# @shared-law (Forge Component)
FROM vde-base:latest

# Build-time arguments and metadata
ARG VM_NAME
ARG PKGS_TO_INSTALL=""
ARG CUSTOM_BUILD_CMD=""
LABEL project="vde" \
      component="spoke" \
      vde.managed="true"

USER root

# 1. Install standard packages as root (Rule 12.5: purge lists after install)
RUN if [ -n "${PKGS_TO_INSTALL}" ]; then \
        apt-get update && \
        apt-get upgrade -y && \
        apt-get install -y ${PKGS_TO_INSTALL} && \
        rm -rf /var/lib/apt/lists/*; \
    fi

# 2. Run custom build command (Special Forces / Hybrid)
# Note: For user-specific installs (Rust/Flutter), the command should use 'su devuser -c'
COPY lib/ /vde/lib/
COPY scripts/setup/${VM_NAME}-init.zsh /vde/scripts/setup/
RUN chmod +x /vde/scripts/setup/${VM_NAME}-init.zsh
RUN if [ -n "${CUSTOM_BUILD_CMD}" ]; then \
        eval "${CUSTOM_BUILD_CMD}"; \
    fi

# 3. Final Purity Check (Rule 12.5)
# Ensures hydration scripts 'purged the ghosts' (vde_purge_ghosts)
RUN if [ -d /var/lib/apt/lists/ ]; then \
        count=$(ls -A /var/lib/apt/lists/ | grep -v "partial" | wc -l); \
        if [ "$count" -gt 0 ]; then \
            echo "ERROR: Rule 12.5 Violation - apt artifacts found in /var/lib/apt/lists/"; \
            ls -al /var/lib/apt/lists/; \
            exit 1; \
        fi \
    fi

# 4. Switch back to root to allow SSHD to start
USER root
WORKDIR /home/devuser/workspace
CMD ["/usr/sbin/sshd", "-D", "-e"]
