#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# VDE Empirical Strike: Integrated Tech Stack
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Objective: Verify the Python/Postgres/Redis stack with direct CLI interaction.
# Codified under Section 14 (The Trial of the Gauntlet).

# 1. Initialize Spine
typeset VDE_ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "${VDE_ROOT_DIR}/lib/vde-core"
source "${VDE_ROOT_DIR}/lib/vde-log"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "VDE EMPIRICAL STRIKE: TECH STACK IGNITION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 2. Setup: Ensure clean slate
echo "[1/5] Purging existing containers..."
"${VDE_ROOT_DIR}/bin/vde" stop all -f >/dev/null 2>&1



# 3. Ignition: Start the fleet
echo "[2/5] Igniting Python, PostgreSQL, and Redis..."
if ! "${VDE_ROOT_DIR}/bin/vde" start python postgres redis; then
    vde_log_error "Ignition failure in tech stack" "forge"
    exit 1
fi

# 4. Verification: Individual Spokes
echo "[3/5] Verifying service readiness..."
# Wait for postgres
if ! "${VDE_ROOT_DIR}/bin/vde-poll" --port 5432 postgres --timeout 60; then
    vde_log_error "PostgreSQL port 5432 failed to open" "forge"
    exit 1
fi

# Wait for redis
if ! "${VDE_ROOT_DIR}/bin/vde-poll" --port 6379 redis --timeout 30; then
    vde_log_error "Redis port 6379 failed to open" "forge"
    exit 1
fi

# 5. The Handshake: Cross-Spoke Connectivity
echo "[4/5] Testing inter-VM bridge (Python -> Services)..."

# Ensure services are actually RUNNING (Atomic Handshake)
"${VDE_ROOT_DIR}/bin/vde-exec" postgres sudo service postgresql start >/dev/null 2>&1
# Restart redis to ensure it picks up the 0.0.0.0 bind from init script
"${VDE_ROOT_DIR}/bin/vde-exec" redis sudo pkill redis-server || true
"${VDE_ROOT_DIR}/bin/vde-exec" redis sudo /usr/bin/redis-server /etc/redis/redis.conf --daemonize yes >/dev/null 2>&1

# Give them a second to breathe
zmodload zsh/zselect && zselect -t 200

# Test Postgres Connectivity from Python Spoke
if "${VDE_ROOT_DIR}/bin/vde-exec" python pg_isready -h vde-postgres -p 5432; then
    vde_log_success "✓ Bridge Python -> PostgreSQL: STABLE" "forge"
else
    vde_log_error "✗ Bridge Python -> PostgreSQL: BROKEN" "forge"
    exit 1
fi

# Test Redis Connectivity from Python Spoke
# We use -h vde-redis explicitly
if "${VDE_ROOT_DIR}/bin/vde-exec" python redis-cli -h vde-redis ping | grep -q "PONG"; then
    vde_log_success "✓ Bridge Python -> Redis: STABLE" "forge"
else
    vde_log_error "✗ Bridge Python -> Redis: BROKEN" "forge"
    exit 1
fi

# 6. Cleanup: Graceful Termination
echo "[5/5] Terminating stack..."
"${VDE_ROOT_DIR}/bin/vde" stop all >/dev/null 2>&1

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ EMPIRICAL STRIKE SUCCESS: Tech Stack Certified"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit 0
