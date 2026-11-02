# VDE PROTOCOL
<!-- @shared-law (Operational Protocol) -->
# The Protocol of the Forge

This protocol defines the immutable laws for interacting with the **Sovereign Baseline**. Deviation from these rituals is a breach of the Creed and may trigger a Protocol Blockade.

---

## 1. Authoritative Tooling (The Rule Spine)

The VDE uses a custom orchestration layer to maintain isolation and hydration parity. Direct interaction with the underlying World-Forge (Docker) is strictly forbidden for standard development.

### The "Anti-Exec" Rule
- **NEVER** use `docker exec` to enter a container.
- **ALWAYS** use `vde enter <alias>` to ensure the SSH bridge, user identity (`devuser`), and tribal environment are active.

### Lifecycle Mandates
- **NEVER** use `docker run` or `docker start` manually.
- **ALWAYS** use `vde start <alias>` to exercise the port-mapping, volume-mounting, and DNS discovery logic.
- **ALWAYS** use `vde rebuild <alias>` for image generation to ensure the **Born Ready (BTO)** build-time hydration is applied.

---

## 2. Material Truth (Data Authority)

- **The Beskar Registry**: `data/vm-types.json` is the sole source of truth for Spoke definitions.
- **Registry Serialization**: All modifications to the registry or port allocation MUST occur inside the global configuration lock (`global-config.lock`) to prevent race conditions.
- **The Physical Handshake**: We do not "assume" a port is free; we **claim** it through a physical diagnostic handshake (`docker run --rm`) before assignment.

---

## 3. The Laws of the Forge (Branching)

We maintain the purity of the Baseline through a strict Git lifecycle:

1. **`main` (Production)**: Reserved for stable, certified releases of the Sovereign Baseline. **All releases and tags occur here.**
2. **`develop` (The Anvil)**: The primary integration branch and default for the repository. All feature work originates here.
3. **The Strike (Feature Branch)**: All work MUST occur on branches originating from `develop` using the format `<type>/<slug>` (e.g., `feat/dns-bridge`).
4. **The Ritual of the Signet and Chronicle**:
    - Every strike begins with a **Signet** (GitHub Issue).
    - Every strike ends with a **Chronicle** (Pull Request).
    - Commits MUST follow **Conventional Commits** (`feat:`, `fix:`, etc.).
    - Merged branches MUST be purged (local and remote) immediately.

---

## 4. The Mandate of Architectural Tagging (Rule 24)

Every file in the ecosystem MUST be tagged on line 2 or 3 to define its Project lineage:

- **`@armor`**: The physical product (student-facing development engine).
- **`@forge`**: The governance system (universal AI-governance and CI/CD).
- **`@shared-law`**: The foundational bridge connecting the two.

---

## 5. Certification (Proof of Life)

No strike is considered complete until it passes the **Mandate L (Proof of Life)** audit. This verifies the absolute lifecycle (`init`, `create`, `rebuild`, `start`, `enter`, `stop`, `remove`, `add`, `uninstall`) remains functional.

**This is the Way.**
