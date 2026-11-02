# Spec: Path of the Foundling Onboarding Integration
<!-- @shared-law (Sovereign Law) -->

**Goal**: Establish `vde path-of-the-foundling` as the primary, interactive entry point for new students, replacing fragmented manual instructions.

## 1. Architecture: The Guided Entry
The onboarding flow will transition from "Command Reference" style to "Interactive Ritual" style. 
- **Primary Method**: `vde path-of-the-foundling` (The Interactive Induction).
- **Secondary/Headless Method**: `vde init` (The Manual Ignition).

## 2. Component Updates

### 2.1 README.md (The Hub's Face)
- **Current**: Directs users to run `vde init`.
- **Change**: Replace with:
  ```zsh
  # Take the Path of the Foundling (Interactive Onboarding)
  vde path-of-the-foundling
  ```
- **Context**: Explain that this script automates the ignition, pillar check, and your first Spoke creation.

### 2.2 docs/guides/getting-started.md (The Warrior's Manual)
- **Section 1 (Installation)**: Update the "Ignite the Forge" ritual to use `vde path-of-the-foundling`.
- **Reference Section**: Keep `vde init` in the command reference table for repair/manual use.

### 2.3 docs/guides/foundling-guide.md (The Seeker's Path)
- **Refactor**: Revolve the entire guide around the interactive induction.
- **Section 2 (Core Rituals)**: Rename "Initialization" to "The Path of the Foundling".
- **Step-by-Step**: Walk through what the script is doing (init -> check -> create python).

### 2.4 docs/quick-start.md (The First Strike)
- **Ritual Update**: Update the step-by-step code block to lead with `vde path-of-the-foundling`.
- **Explanation**: Update the "What Just Happened?" section to reflect the interactive flow.

## 3. Testing & Verification
- **Doc Linting**: Ensure all links and formatting are preserved.
- **Dry-Run**: Verify that the instructions in the new README work for a fresh clone (simulated).

---
**Architectural Tag**: @forge
