# VDE ARCHITECTURAL RECORD
# @forge (Governance Sentinel)
# BDD Test Runner Container for VDE
# Runs behave (Python BDD framework) to test .feature files

FROM python:3.13-slim

LABEL maintainer="VDE Project"
LABEL description="BDD test runner with behave for VDE feature tests"

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        zsh \
        docker-compose \
        docker-cli \
        openssh-client \
        git \
        curl \
        jq \
        bash \
    && rm -rf /var/lib/apt/lists/*

# Install Python BDD framework
RUN pip install --no-cache-dir \
    behave==1.3.2 \
    pytest==8.3.4 \
    pyyaml==6.0.2

# Create test workspace directory
WORKDIR /vde

# Copy VDE scripts and libraries needed for testing
COPY bin/ /vde/bin/
COPY lib/ /vde/lib/
COPY data/ /vde/data/
COPY templates/ /vde/templates/
COPY tests/ /vde/tests/
COPY configs/ /vde/configs/
COPY env-files/ /vde/env-files/

# Make scripts executable
RUN find /vde/bin -type f -exec chmod +x {} \; && \
    find /vde/tests -name "*.sh" -exec chmod +x {} \;

# Create necessary directories
RUN mkdir -p /vde/{configs,projects,data,logs,public-ssh-keys,.locks,.cache}

# Copy feature files explicitly for clarity
COPY tests/features/ /vde/tests/features/

# Create behave.ini in the tests directory
COPY tests/behave.ini /vde/tests/behave.ini

# Set up environment
ENV PYTHONUNBUFFERED=1
ENV VDE_ROOT_DIR=/vde
ENV VDE_TEST_MODE=1
ENV PATH="/vde/bin:/vde/tests:${PATH}"

# Default command runs behave
CMD ["behave", "--format", "pretty", "--format", "json", "--outfile", "/tmp/behave-report.json"]
