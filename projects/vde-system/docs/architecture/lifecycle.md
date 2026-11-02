# LIFECYCLE OF A SPOKE
<!-- @armor (Container Orchestration) -->
**The Lifecycle of a Spoke in the VDE Sovereign Baseline (1.5.5)** is governed by the **Proof of Life Contract**, a non-negotiable functional sequence that ensures system integrity from initial hydration to final decommissioning.

### **At a Glance: The Spoke Lifecycle**

The lifecycle follows a strictly enforced path: **Init → Create → Start → Enter → Stop → Remove**.

---

### **1. Ignition: Initialization and Creation**

*   **The Initialization Ritual (`vde init`)**: This pre-flight phase hydrates the Hub's infrastructure. It forges the `vde_student` SSH identity keys, establishes the `vde-net` bridge, and builds the foundational `vde-base` image.
*   **Spoke Creation (`vde create <alias>`)**: A new Spoke image is smelted from the Beskar Registry definition. This process uses **Universal Script Parity (USP)** to hydrate the environment at build-time, ensuring the Spoke is **Born Ready (BTO)** with no runtime network dependencies.
*   **Dynamic Registration (`vde add`)**: New Spoke types can be registered dynamically, enforcing the 8-field standard registry structure.

### **2. Active Service**

*   **Spoke Ignition (`vde start <alias>`)**: The container process is ignited. This includes a "System Breath" resource check and a **Physical Handshake** to verify port availability.
*   **The Sovereign Handshake (`vde enter <alias>`)**: The user enters the Spoke's login shell as the `devuser` account via the secure SSH transversal bridge. This bridge utilizes a `socat` proxy to forward the host's SSH agent into the Spoke.
*   **Workspace Persistence**: Inside the Spoke, the user operates at `$HOME/workspace/`. This directory is **persistently synced** to `projects/<alias>` on the Hub. Work saved here survives image rebuilds and container dissolution.

### **3. Maintenance and Re-Forging**

*   **Re-smelting (`vde rebuild <alias>`)**: If a Spoke requires updates or becomes unstable, it is re-forged. This rebuilds the Spoke's Docker image (defaulting to `--no-cache`) to restore the factory baseline while preserving the `$HOME/workspace/` data.

### **4. Decommissioning: The Quench and Dissolution**

*   **The Quench (`vde stop <alias>`)**: The running Spoke process is stopped, releasing Hub memory and CPU while keeping the instance registered.
*   **Dissolution (`vde rm <alias>`)**: The Spoke instance and its associated atomic file locks are dissolved from the Hub.
*   **Permanent Removal (`vde uninstall <alias>`)**: The Spoke type is permanently removed from the Beskar Registry.
*   **The Great Quench (`vde nuke`)**: A comprehensive cleanup ritual that removes all VDE containers, images, networks, and configurations from the Hub.

---

**This is the Way.**
