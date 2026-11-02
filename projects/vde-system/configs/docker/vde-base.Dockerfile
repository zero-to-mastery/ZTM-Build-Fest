# VDE ARCHITECTURAL RECORD
# @shared-law (Forge Component)
# VDE-BASE (The Hub)
FROM debian:bookworm-slim
LABEL project="vde" component="hub"

# 1. Absolute OS Baseline
RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    sudo \
    openssh-server \
    zsh \
    git \
    curl \
    wget \
    jq \
    iputils-ping \
    dnsutils \
    netcat-openbsd \
    socat \
    vim \
    build-essential \
    procps \
    locales \
    ca-certificates \
    gnupg \
    lsb-release \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 1.1 Install Docker CLI (for Sovereign features)
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && apt-get install -y docker-ce-cli socat && \
    rm -rf /var/lib/apt/lists/*

# 2. Locale & Identity Setup
RUN sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# 3. SSH Server Configuration (The Gate)
RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    echo "AllowAgentForwarding yes" >> /etc/ssh/sshd_config && \
    echo "AuthorizedKeysFile /home/devuser/.ssh/vde/authorized_keys" >> /etc/ssh/sshd_config
# Note: StrictModes defaults to 'yes'. The entrypoint enforces correct ownership
# and permissions at runtime, so StrictModes yes is safe and intentional.

# 4. The Student Environment (User & Oh-My-Zsh)
RUN useradd -ms /bin/zsh -u 1000 devuser && \
    echo "devuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    chmod 755 /home/devuser

USER devuser
WORKDIR /home/devuser

RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended && \
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions

# Force xterm-256color when connecting from ghostty.
# xterm-ghostty terminfo is not installed on this host.
RUN printf 'if [[ "$TERM" == "xterm-ghostty" ]]; then\n    export TERM=xterm-256color\nfi\n' >> ~/.zshrc

# 5. SSH Key Preparation
# The VDE public key is injected dynamically via the entrypoint (Option B)
RUN mkdir -p /home/devuser/.ssh/vde && \
    chmod 700 /home/devuser/.ssh && \
    chmod 700 /home/devuser/.ssh/vde && \
    chown -R devuser:devuser /home/devuser/.ssh

# 5.1. Internal SSH Configuration (Lateral Bridge)
COPY --chown=devuser:devuser configs/ssh/config.spoke /home/devuser/.ssh/config
RUN chmod 600 /home/devuser/.ssh/config

# 6. THE ATOMIC HANDSHAKE (Entrypoint)
COPY scripts/vde-entrypoint.zsh /usr/local/bin/vde-entrypoint.zsh
COPY scripts/vde-motd.zsh /usr/local/bin/vde-motd.zsh
RUN sudo chmod +x /usr/local/bin/vde-entrypoint.zsh /usr/local/bin/vde-motd.zsh

# 7. Universal Login Message (MOTD)
USER root
RUN echo 'zsh /usr/local/bin/vde-motd.zsh' >> /etc/zsh/zprofile

USER devuser
WORKDIR /home/devuser/workspace
ENTRYPOINT ["/usr/local/bin/vde-entrypoint.zsh"]
