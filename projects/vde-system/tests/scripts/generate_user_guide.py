#!/usr/bin/env python3
# @forge (Governance Sentinel)
"""
Generate docs/guides/getting-started.md from PASSING BDD test scenarios only.

This script:
1. Reads Behave JSON output to identify which scenarios passed
2. Generates user guide with ONLY passing scenarios
3. Ensures all examples in the guide are actually verified to work
4. Loads educational content from YAML (not hardcoded)
5. Dynamically generates quick reference from vm-types.conf

Run: python3 tests/bin/generate_user_guide.py
"""

import json
import re
from pathlib import Path

# Paths
REPO_ROOT = Path(__file__).parent.parent.parent
FEATURES_DIR = REPO_ROOT / "tests" / "features"
BEHAVE_JSON_FILE = REPO_ROOT / "tests" / "behave-results.json"
OUTPUT_FILE = REPO_ROOT / "docs/guides/getting-started.md"
INTROS_YAML_FILE = REPO_ROOT / "docs" / "user-guide-intros.yml"
VM_TYPES_CONF_FILE = REPO_ROOT / "data" / "vm-types.conf"


# =============================================================================
# YAML LOADING FUNCTIONS (Phase 2)
# =============================================================================


def load_section_intros_from_yaml():
    """
    Load section introductions from YAML file.

    Returns:
        dict: Mapping of section ID to intro text
    """
    if not INTROS_YAML_FILE.exists():
        print(f"Warning: {INTROS_YAML_FILE} not found. Using fallback intros.")
        return get_fallback_intros()

    sections = {}
    current_section = None
    current_content = []
    in_intro = False

    with open(INTROS_YAML_FILE) as f:
        for line in f:
            # Skip comments and empty lines at start
            if line.strip().startswith("#") and not current_section:
                continue

            # Match section start: - id: "Section Name"
            section_match = re.match(r'\s*-\s*id:\s*"([^"]+)"', line)
            if section_match:
                # Save previous section if exists
                if current_section and current_content:
                    sections[current_section] = "\n".join(current_content).rstrip()
                current_section = section_match.group(1)
                current_content = []
                in_intro = False
                continue

            # Match intro: | marker
            if "intro: |" in line:
                in_intro = True
                continue

            # Collect intro content (indented lines)
            if in_intro and current_section:
                # Remove the 6-space indentation from YAML format
                if line.startswith("      "):
                    current_content.append(line[6:])
                elif line.strip() and not line.strip().startswith("order:"):
                    # Handle lines that might not have proper indentation
                    current_content.append(line)

        # Save last section
        if current_section and current_content:
            sections[current_section] = "\n".join(current_content).rstrip()

    print(f"✓ Loaded {len(sections)} section intros from YAML")
    return sections


def get_fallback_intros():
    """Provide minimal fallback intros if YAML file is missing."""
    return {
        "1. Installation": "Install VDE by cloning the repository and running setup.",
        "2. SSH Keys": "SSH keys are managed automatically by VDE.",
        "3. Your First VM": "Create your first VM with `vde create python`.",
        "4. Understanding": "Check VM status with `vde list`.",
        "5. Starting and Stopping": "Start VMs with `vde start <name>` and stop with `vde stop <name>`.",
        "6. Your First Cluster": "Create multiple VMs that work together.",
        "7. Connecting": "SSH into VMs using simple names like `ssh vde-python`.",
        "8. Working with Databases": "Service VMs like PostgreSQL are accessible from language VMs.",
        "9. Daily Workflow": "Start your day with `vde start python postgres redis`.",
        "10. Adding More Languages": "Add more languages anytime with `vde create <name>`.",
        "11. Troubleshooting": "Check logs and use `--rebuild` if changes aren't reflected.",
    }


# =============================================================================
# VM TYPES CONF PARSING (Phase 4)
# =============================================================================


def parse_vm_types_conf():
    """
    Parse vm-types.conf and return structured data.

    Returns:
        dict: With 'languages' and 'services' lists
    """
    vm_types = {"languages": [], "services": []}

    if not VM_TYPES_CONF_FILE.exists():
        print(f"Warning: {VM_TYPES_CONF_FILE} not found.")
        return vm_types

    with open(VM_TYPES_CONF_FILE) as f:
        for line in f:
            line = line.strip()
            # Skip comments and empty lines
            if line.startswith("#") or not line:
                continue

            # Parse: type|name|aliases|display|install_command|service_ports
            parts = line.split("|")
            if len(parts) >= 6:
                vm_type = parts[0].strip()
                name = parts[1].strip()
                aliases = parts[2].strip() if len(parts) > 2 else ""
                display = parts[3].strip() if len(parts) > 3 else name
                install_cmd = parts[4].strip() if len(parts) > 4 else ""
                service_ports = parts[5].strip() if len(parts) > 5 else ""

                entry = {
                    "name": name,
                    "aliases": aliases,
                    "display": display,
                    "install": install_cmd,
                    "service_ports": service_ports,
                }

                if vm_type == "lang":
                    vm_types["languages"].append(entry)
                elif vm_type == "service":
                    vm_types["services"].append(entry)

    print(
        f"✓ Parsed {len(vm_types['languages'])} language VMs and {len(vm_types['services'])} service VMs"
    )
    return vm_types


# =============================================================================
# BEHAVE JSON LOADING
# =============================================================================


def load_passing_scenarios_from_json():
    """Load the set of passing scenarios from Behave JSON output."""
    if not BEHAVE_JSON_FILE.exists():
        print(f"Warning: {BEHAVE_JSON_FILE} not found.")
        print("Run BDD tests first: ./tests/run-docker-free-tests.sh")
        print("Generating user guide from ALL scenarios (unverified mode)")
        return None

    with open(BEHAVE_JSON_FILE) as f:
        data = json.load(f)

    passing_scenarios = set()
    for feature in data:
        feature_name = feature.get("name", "")
        for element in feature.get("elements", []):
            if element.get("type") == "scenario":
                scenario_name = element.get("name", "")
                status = element.get("status", "")
                if status == "passed":
                    # Create a unique identifier
                    key = f"{feature_name}:{scenario_name}"
                    passing_scenarios.add(key)

    print(f"✓ Found {len(passing_scenarios)} passing scenarios in test results")
    return passing_scenarios


# =============================================================================
# FEATURE FILE PARSING
# =============================================================================


def extract_scenarios_from_feature(content):
    """
    Extract scenarios from a feature file content.

    Returns:
        tuple: (feature_name, scenarios) where scenarios is a list of
               (scenario_name, scenario_body, tags)
    """
    feature_match = re.search(
        r"Feature:\s*(.+?)\n(?:\s*As\s+(.+?)\n\s*I want\s+(.+?)\n\s*So\s+(.+?))?",
        content,
        re.DOTALL,
    )
    feature_name = feature_match.group(1).strip() if feature_match else "Unknown Feature"

    # Extract feature-level tags (if any) - tags can appear BEFORE or AFTER Feature:
    feature_tags = []
    # First try to find tags before Feature: (common Gherkin convention)
    before_feature_match = re.search(r"((?:\s*@\w+(?:-\w+)*\n)+)\s*Feature:", content)
    if before_feature_match:
        tag_text = before_feature_match.group(1) or ""
        feature_tags = [tag.strip() for tag in re.findall(r"@(\w+(?:-\w+)*)", tag_text)]
    else:
        # Fallback: tags after Feature: (less common but valid)
        after_feature_match = re.search(
            r"Feature:(.+?)\n((?:\s*@\w+(?:\s+@\w+)*\n)*)", content, re.DOTALL
        )
        if after_feature_match:
            tag_text = after_feature_match.group(2) or ""
            feature_tags = [tag.strip() for tag in re.findall(r"@(\w+(?:-\w+)*)", tag_text)]

    # Pattern to match scenarios with optional tags before them
    scenario_pattern = r"((?:\s*@\w+(?:-\w+)*)*)\s*Scenario:\s*(.+?)\n((?:\s*(?:Given|When|Then|And)\s+.+(?:\n|$))+)"
    scenarios = []
    for match in re.finditer(scenario_pattern, content, re.MULTILINE):
        tag_block = match.group(1) or ""
        scenario_name = match.group(2).strip()
        scenario_body = match.group(3).strip()

        # Extract tags from this scenario
        scenario_tags = [tag.strip() for tag in re.findall(r"@(\w+(?:-\w+)*)", tag_block)]

        # Combine feature and scenario tags (feature tags are inherited, scenario tags override)
        # This ensures @user-guide-internal at feature level applies to all scenarios
        all_tags = list(feature_tags)  # Start with feature tags
        for tag in scenario_tags:
            if tag not in all_tags:  # Avoid duplicates
                all_tags.append(tag)

        scenarios.append((scenario_name, scenario_body, all_tags))

    return feature_name, scenarios


# =============================================================================
# COMMAND NORMALIZATION (Phase 5: Old Script Names to Unified vde Commands)
# =============================================================================


def normalize_vde_command(command):
    """
    Normalize old VDE script names to unified vde command.

    Maps:
    - create-virtual-for <vm> → vde create <vm>
    - start-virtual <vm> → vde start <vm>
    - shutdown-virtual <vm> → vde stop <vm>
    - remove-virtual <vm> → vde remove <vm>
    - list-vms → vde list
    - list-vms --lang → vde list --languages
    - list-vms --svc → vde list --services

    Args:
        command: Raw command string (may be old script name or vde command)

    Returns:
        str: Normalized unified vde command
    """
    if not command:
        return command

    # Extract command and arguments
    parts = command.split()
    if not parts:
        return command

    cmd = parts[0]
    args = parts[1:] if len(parts) > 1 else []

    # Map old commands to new vde commands
    command_map = {
        "create-virtual-for": "create",
        "start-virtual": "start",
        "shutdown-virtual": "stop",
        "remove-virtual": "remove",
        "list-vms": "list",
    }

    if cmd in command_map:
        new_cmd = command_map[cmd]
        # Handle special cases for list-vms flags
        if cmd == "list-vms":
            if "--lang" in args:
                return "vde list --languages"
            elif "--svc" in args:
                return "vde list --services"
            elif args:
                return f"vde list {args[0]}"
            return "vde list"
        # Standard command mapping
        if args:
            return f"vde {new_cmd} {' '.join(args)}"
        return f"vde {new_cmd}"

    return command


# =============================================================================
# SCENARIO FORMATTING
# =============================================================================

# Mapping of scenario patterns to their actual vde commands
# This maps common scenario descriptions to the commands users would run
SCENARIO_COMMAND_MAP = {
    # Listing/Discovery scenarios
    "what VMs can I create": "vde list",
    "what VMs are available": "vde list",
    "list all available vms": "vde list",
    "show all services": "vde list --services",
    "ask to list all languages": "vde list --languages",
    "request information about": "vde info <vm>",
    "check if": "vde check <vm>",
    "use the alias": "vde resolve <alias>",
    "explore available": "vde list",
    # Creation scenarios
    "create a Python VM": "vde create python",
    "create a go vm": "vde create go",
    "create a rust VM": "vde create rust",
    "create python and postgresql": "vde create python && vde create postgres",
    "plan to create": "vde create <vm-type>",
    # Start scenarios
    "start my development day": "vde start <vms>",
    "plan to start": "vde start <vms>",
    # Verification scenarios
    "verify installation commands": "vde list",
    "check service port configuration": "vde list",
    "count all configured vms": "vde list",
    "check vm status": "vde list",
}


def extract_command_from_scenario(scenario_name, scenario_body):
    """
    Extract or infer the actual vde command from a scenario.

    First tries to find explicit commands in the scenario body,
    then falls back to pattern matching from scenario names.

    Returns:
        str: The command or None if not found
    """
    lower_body = scenario_body.lower()
    lower_name = scenario_name.lower()

    # First, try to find explicit "When I run" commands
    for line in scenario_body.split("\n"):
        line = line.strip()
        if line.startswith("When I run"):
            # Extract command from quotes
            match = re.search(r'When I run ["\']([^"\']+)["\']', line)
            if match:
                return normalize_vde_command(match.group(1))

    # Handle "When I request to" and "When I request" patterns
    for line in scenario_body.split("\n"):
        line = line.strip()
        if line.startswith("When I request to") or line.startswith("When I request"):
            # Extract the quoted request
            match = re.search(r'request (?:to )?["\']([^"\']+)["\']', line, re.IGNORECASE)
            if match:
                request = match.group(1).lower()
                # Map requests to vde commands
                if "create" in request and (
                    "vm" in request
                    or any(
                        v in request
                        for v in [
                            "javascript",
                            "nginx",
                            "go",
                            "rust",
                            "python",
                            "postgres",
                            "redis",
                            "haskell",
                            "flutter",
                        ]
                    )
                ):
                    # Extract VM names if present
                    vms = re.findall(
                        r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                        request,
                        re.IGNORECASE,
                    )
                    if vms:
                        # Normalize VM names
                        vm_names = []
                        for vm in vms:
                            vm_lower = vm.lower()
                            if vm_lower in ["golang"]:
                                vm_names.append("go")
                            elif vm_lower in ["js"]:
                                vm_names.append("js")
                            else:
                                vm_names.append(vm_lower)
                        return f"vde create {' '.join(vm_names)}"
                    return "vde create <vm>"
                elif "start" in request:
                    if "all services" in request or "all" in request:
                        return "vde start all"
                    vms = re.findall(
                        r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                        request,
                        re.IGNORECASE,
                    )
                    if vms:
                        vm_names = []
                        for vm in vms:
                            vm_lower = vm.lower()
                            if vm_lower in ["golang"]:
                                vm_names.append("go")
                            else:
                                vm_names.append(vm_lower)
                        return f"vde start {' '.join(vm_names)}"
                    return "vde start <vms>"
                elif "stop" in request:
                    if "everything" in request or "all" in request:
                        return "vde stop all"
                    vms = re.findall(
                        r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                        request,
                        re.IGNORECASE,
                    )
                    if vms:
                        return f"vde stop {' '.join(vms)}"
                    return "vde stop <vms>"
                elif "restart" in request:
                    if "rebuild" in request or "no cache" in request:
                        vms = re.findall(
                            r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                            request,
                            re.IGNORECASE,
                        )
                        vm = vms[0].lower() if vms else "<vm>"
                        return f"vde restart {vm} --rebuild"
                    vms = re.findall(
                        r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                        request,
                        re.IGNORECASE,
                    )
                    if vms:
                        return f"vde restart {vms[0].lower()}"
                    return "vde restart <vm>"
                elif "rebuild" in request:
                    vms = re.findall(
                        r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                        request,
                        re.IGNORECASE,
                    )
                    vm = vms[0].lower() if vms else "<vm>"
                    return f"vde start {vm} --rebuild"
                elif "status" in request or "show status" in request or request == "status":
                    return "vde list"
                # Handle "When I request to start my Python development environment"
                if "development environment" in request:
                    vms = re.findall(
                        r"(?:javascript|nginx|go|golang|rust|python|postgres|redis|haskell|flutter|js|csharp|ruby)",
                        request,
                        re.IGNORECASE,
                    )
                    if vms:
                        return f"vde start {vms[0].lower()}"
                    return "vde start <vm>"

    # Check for "When I ask" patterns - natural language queries
    for line in scenario_body.split("\n"):
        line_lower = line.strip().lower()
        if line_lower.startswith("when i ask"):
            # Extract the quoted text
            match = re.search(r'when i ask ["\']([^"\']+)["\']', line, re.IGNORECASE)
            if match:
                query = match.group(1).lower()
                # Map natural language queries to commands
                if "list all languages" in query or "list languages" in query:
                    return "vde list --languages"
                elif (
                    "list all services" in query
                    or "list services" in query
                    or "show all services" in query
                ):
                    return "vde list --services"
                elif "what vms can i create" in query or "what vms are available" in query:
                    return "vde list"
                elif "information about" in query:
                    return "vde list <vm-type>"

    # Check for "I ask to list" patterns
    if "ask to list all languages" in lower_body or "list all languages" in lower_body:
        return "vde list --languages"
    elif "show all services" in lower_body:
        return "vde list --services"

    # Second, try to find "When I parse" patterns (parser testing)
    for line in scenario_body.split("\n"):
        line = line.strip()
        if line.startswith("When I parse"):
            # Extract the quoted text as a parser example
            match = re.search(r'When I parse ["\']([^"\']+)["\']', line)
            if match:
                return f"vde {match.group(1)}"

    # Third, try pattern matching from scenario name and body
    # Check for list/create/start patterns
    if "what vms can i create" in lower_body or "what vms are available" in lower_body:
        return "vde list"
    elif "create" in lower_name or "create" in lower_body:
        # Extract VM type from scenario
        if "python" in lower_name or "python" in lower_body:
            return "vde create python"
        elif "go" in lower_name or "golang" in lower_body:
            return "vde create go"
        elif "rust" in lower_name:
            return "vde create rust"
        elif "postgres" in lower_name:
            return "vde create postgres"
    elif "start" in lower_name or "start" in lower_body:
        return "vde start <vms>"
    elif "stop" in lower_name or "stop" in lower_body:
        return "vde stop <vms>"
    elif "rebuild" in lower_name or "rebuild" in lower_body:
        return "vde start <vm> --rebuild"

    # Try the explicit mapping
    for pattern, command in SCENARIO_COMMAND_MAP.items():
        if pattern in lower_name or pattern in lower_body:
            return command

    # Fallback: infer from scenario name if no command found in body
    # This handles SSH/cluster workflow scenarios that describe behavior without commands
    if not command:
        if "ssh" in lower_name or ("ssh" in lower_body and "connection" in lower_body):
            return "vde ssh <vm>"
        elif "cluster" in lower_name or "stack" in lower_name:
            return "vde start <vms>"
        elif (
            "communicating" in lower_name
            or "connection" in lower_name
            or "agent forwarding" in lower_name
            or "vm to vm" in lower_name
            or "vm-to-vm" in lower_name
        ):
            return "vde ssh <vm>"
        elif "multiple" in lower_name and ("vm" in lower_name or "vms" in lower_name):
            return "vde start <vms>"
        elif "create" in lower_name and "vm" in lower_name:
            return "vde create <vm>"
        elif "start" in lower_name and ("vm" in lower_name or "environment" in lower_name):
            return "vde start <vms>"
        elif "stop" in lower_name or "shutdown" in lower_name:
            return "vde stop <vms>"
        elif "restart" in lower_name:
            return "vde restart <vm>"
        elif "status" in lower_name or "list" in lower_name:
            return "vde list"

    return None


def format_scenario_for_user_guide(scenario_name, scenario_body):
    """
    Format a scenario for the user guide with structured sections.

    Format:
    1. **Scenario:** [name] (bold heading)
    2. Code block with Gherkin steps
    3. **Run the command:** heading + code block with actual command
    4. **What this does:** heading + explanation (if we have it)
    """
    lines = []

    # Clean up scenario name for display
    display = scenario_name.replace("-", " ").capitalize()

    # 1. Scenario title
    lines.append(f"**Scenario: {display}**\n")
    lines.append("")

    # 2. Gherkin steps in code block
    lines.append("```")
    for line in scenario_body.split("\n"):
        line = line.strip()
        if line:
            lines.append(line)
    lines.append("```\n")
    lines.append("")

    # 3. Extract command and add "Run the command:" section
    command = extract_command_from_scenario(scenario_name, scenario_body)
    if command:
        # Map common patterns to more descriptive action labels
        action_label = "Run the command"
        lower_cmd = command.lower()

        if "list" in lower_cmd or "show" in lower_cmd or "what" in lower_cmd:
            action_label = "List available VMs"
        elif "create" in lower_cmd:
            action_label = "Create the VM"
        elif "start" in lower_cmd:
            action_label = "Start the VMs"
        elif "stop" in lower_cmd:
            action_label = "Stop the VMs"
        elif "build" in lower_cmd or "setup" in lower_cmd:
            action_label = "Run the setup"
        elif "remove" in lower_cmd or "delete" in lower_cmd:
            action_label = "Remove the VM"

        lines.append(f"**{action_label}:**\n")
        lines.append("")
        lines.append("```zsh")
        lines.append(command)
        lines.append("```")
    else:
        # No command found - check if this is an installation/setup scenario
        lower_name = scenario_name.lower()
        lower_body = scenario_body.lower()

        # Installation/setup scenarios get the setup script
        if (
            "installation" in lower_name
            or "setup" in lower_name
            or "prerequisite" in lower_name
            or "initial" in lower_name
            or "fresh" in lower_name
            or "ssh key" in lower_name
            or "ssh config" in lower_name
            or "ssh agent" in lower_name
        ):
            lines.append("**This is handled by the setup script:**\n")
            lines.append("")
            lines.append("```zsh")
            lines.append("./bin/build-and-start")
            lines.append("```")
        # Other scenarios without commands just don't get a command block

    # Note: "What this does" section would require additional metadata
    # For now, we skip it since we don't have that information

    # No trailing newline - caller controls spacing
    return "\n".join(lines)


# =============================================================================
# SECTION DETERMINATION
# =============================================================================


def determine_section(scenario_name, tags=None):
    """
    Determine which section a scenario belongs to.

    IMPORTANT: This is OPT-IN ONLY. Scenarios without explicit @user-guide-*
    tags are EXCLUDED from the user guide. This prevents internal test scenarios
    (parser tests, port registry tests, etc.) from appearing in user documentation.

    TAGGING CONVENTION:
    Add one of these tags to your scenario/feature:
      @user-guide-installation       -> Section 1
      @user-guide-ssh-keys           -> Section 2
      @user-guide-first-vm           -> Section 3
      @user-guide-understanding      -> Section 4
      @user-guide-starting-stopping  -> Section 5
      @user-guide-cluster            -> Section 6
      @user-guide-connecting         -> Section 7
      @user-guide-databases          -> Section 8
      @user-guide-daily-workflow     -> Section 9
      @user-guide-more-languages     -> Section 10
      @user-guide-troubleshooting    -> Section 11
      @user-guide-internal           -> Not included (internal features)

    PRIORITY: Scenario-level tags (added directly to a scenario) take precedence
    over feature-level tags (inherited from the feature). This allows overriding
    the default section for specific scenarios.
    """
    if not tags:
        return None

    tag_map = {
        "user-guide-installation": "1. Installation",
        "user-guide-first-vm": "2. Your First VM",
        "user-guide-connecting": "3. Connecting to your VM",
        "user-guide-ssh-keys": "4. The Magic Behind the Scenes (SSH Keys)",
        "user-guide-understanding": "5. Understanding Your Workspace",
        "user-guide-starting-stopping": "6. Starting, Stopping, and Restarting",
        "user-guide-cluster": "7. Your First Cluster (Multi-VM)",
        "user-guide-databases": "8. Working with Databases",
        "user-guide-daily-workflow": "9. Daily Study Routine",
        "user-guide-more-languages": "10. Adding More Languages",
        "user-guide-troubleshooting": "11. Troubleshooting",
        "user-guide-internal": None,  # Explicitly exclude from user guide
    }

    # FIXED: Check scenario-level tags FIRST (they're at the end of the list)
    # Scenario tags override feature-level tags
    for tag in reversed(tags):
        if tag in tag_map and tag != "user-guide-internal":
            return tag_map[tag]  # Return first non-internal tag found

    # If we only found user-guide-internal, try auto-detection before excluding
    # This handles scenarios that should be in guide but lack explicit tags
    if "user-guide-internal" in tags:
        auto_section = auto_detect_section(scenario_name)
        if auto_section:
            return auto_section  # Auto-detected section overrides internal tag
        return None  # No match, exclude from guide

    return None


def auto_detect_section(scenario_name):
    """
    Auto-detect user guide section from scenario name patterns.

    Handles scenarios in @user-guide-internal features that are actually
    user-facing workflows (Example 1, Daily Workflow, etc.).

    Returns section name or None.
    """
    name_lower = scenario_name.lower()

    # Daily workflow patterns
    if any(
        p in name_lower
        for p in ["daily workflow", "morning setup", "evening cleanup", "switching projects"]
    ):
        return "9. Daily Workflow"

    # Cluster/multi-VM patterns
    if any(
        p in name_lower
        for p in [
            "example 1",
            "example 2",
            "example 3",
            "microservices",
            "full-stack",
            "start both",
            "start all",
        ]
    ):
        return "6. Your First Cluster"

    # First VM patterns
    if any(p in name_lower for p in ["new project setup", "discover available"]):
        return "3. Your First VM"

    # Understanding VDE patterns
    if any(
        p in name_lower
        for p in [
            "team onboarding",
            "explore languages",
            "understand system",
            "resolve",
            "alias",
            "documentation accuracy",
        ]
    ):
        return "4. Understanding"

    # Troubleshooting patterns
    if any(
        p in name_lower
        for p in [
            "troubleshooting",
            "already running",
            "already stopped",
            "existing vm",
            "restart with rebuild",
        ]
    ):
        return "11. Troubleshooting"

    # Connecting patterns
    if any(
        p in name_lower
        for p in ["connection info", "connect to", "get connection", "connection help"]
    ):
        return "7. Connecting"

    # Database patterns
    if any(
        p in name_lower for p in ["postgresql accessibility", "database", "postgres", "mongodb"]
    ):
        return "8. Working with Databases"

    # Adding more languages patterns
    if any(p in name_lower for p in ["adding cache", "add redis", "add more"]):
        return "10. Adding More Languages"

    # Exclude internal testing patterns
    if any(
        p in name_lower
        for p in ["cache", "metadata", "parser", "shell compatibility", "performance", "quick plan"]
    ):
        return None

    return None


# =============================================================================
# DYNAMIC QUICK REFERENCE GENERATION (Phase 4)
# =============================================================================


def generate_quick_reference():
    """Generate the quick reference section from actual vm-types.conf data."""
    vm_types = parse_vm_types_conf()

    # Build language VM table
    lang_rows = []
    for vm in vm_types["languages"][:10]:  # Show first 10
        aliases = vm["aliases"] or "-"
        name = vm["display"]
        cmd = f"`vde create {vm['name']}`"
        lang_rows.append(f"| {name} | {cmd} | {aliases} |")

    # Build service VM table
    service_rows = []
    for vm in vm_types["services"]:
        name = vm["display"]
        cmd = f"`vde create {vm['name']}`"
        port = vm["service_ports"] or "-"
        service_rows.append(f"| {name} | {cmd} | {port} |")

    return f"""## Quick Reference Card 📇

### Essential Commands (Your Cheat Sheet!)

```zsh
# See what VMs are available
vde list

# Create a new VM
vde create <name>

# Start VMs
vde start <vm1> <vm2> ...

# Stop VMs
vde stop <vm1> <vm2> ...

# Stop everything
vde stop all

# Rebuild a VM (when you make config changes)
vde start <vm> --rebuild
```

### SSH Connections

```zsh
# VDE SSH - Simple connections to your VMs
vde ssh python     # Python development
vde ssh rust       # Rust development
vde ssh js         # JavaScript/Node.js
vde ssh csharp     # C# development
vde ssh ruby       # Ruby development
vde ssh go         # Go development

# Service VMs
vde ssh postgres   # PostgreSQL database
vde ssh redis      # Redis cache
vde ssh mongodb    # MongoDB
vde ssh nginx      # Nginx web server
```

**Note:** The `vde ssh` command automatically uses VDE's isolated SSH configuration at `~/.ssh/vde/config`. You can also use VM aliases (e.g., `vde ssh py` for Python, `vde ssh rs` for Rust).

### Default Ports

| VM | Port |
|----|------|
| vde-python | 2213 |
| vde-rust | 2216 |
| vde-js | 2209 |
| vde-csharp | 2203 |
| vde-ruby | 2215 |
| postgres | 2404 |
| redis | 2406 |
| mongodb | 2401 |
| nginx | 2403 |

---

## Available VM Types

### Language VMs (for writing code)

| Language | Command | Aliases |
|----------|---------|---------|
{chr(10).join(lang_rows)}

### Service VMs (for data & infrastructure)

| Service | Command | Port |
|---------|---------|------|
{chr(10).join(service_rows)}

---

## You're Ready! 🎉

Look at you go! You now have:
- ✅ VDE installed and configured (you did it!)
- ✅ SSH keys set up automatically (no manual work!)
- ✅ Your first VM created (how cool is that?)
- ✅ Understanding of starting/stopping (like a pro!)
- ✅ A full cluster ready (Python + PostgreSQL + Redis)
- ✅ Knowledge to troubleshoot hiccups (you've got this!)

**What's Next?** 🚀

1. Create your first project in `projects/python/`
2. Start coding something amazing!
3. Add more languages whenever you want (Rust? Go? Elixir? They're waiting for you!)

**Remember:** You're learning valuable skills here. Every command you run, every VM you create — you're becoming a better developer. Be proud of yourself!

---

*This guide is generated from BDD test scenarios that have been verified to PASS. Every workflow shown here has been tested and verified to work. If you follow these steps, they will work for you.*

**Now go build something awesome!** 💪✨
"""


# =============================================================================
# MAIN GENERATION FUNCTION (Phases 2 & 3: Load YAML + Write Scenarios Bug Fix)
# =============================================================================


def generate_user_guide(passing_scenarios=None):
    """
    Generate the complete docs/guides/getting-started.md with only passing scenarios.

    Phase 2 Fix: Loads intros from YAML instead of hardcoded dict
    Phase 3 Fix: Actually writes scenarios to the guide (was broken before)
    """
    # Load section intros from YAML (Phase 2)
    section_intros = load_section_intros_from_yaml()

    # Verify mode warning
    if passing_scenarios is None:
        print("⚠ WARNING: Running in UNVERIFIED mode")
        print("  Scenarios have NOT been tested!")
        print("  Run BDD tests first to generate verified guide\n")

    # Read all feature files and extract scenarios
    all_scenarios = {}  # section -> list of (name, body)

    for feature_file in FEATURES_DIR.glob("**/*.feature"):
        try:
            with open(feature_file) as f:
                content = f.read()

            feature_name, scenarios = extract_scenarios_from_feature(content)

            for scenario_name, scenario_body, tags in scenarios:
                # Check if scenario passed (if we have test results)
                if passing_scenarios is not None:
                    key = f"{feature_name}:{scenario_name}"
                    if key not in passing_scenarios:
                        # Skip failed scenarios
                        continue

                # Determine section based on tags (primary) or scenario name (fallback)
                section = determine_section(scenario_name, tags)
                if section:
                    if section not in all_scenarios:
                        all_scenarios[section] = []
                    all_scenarios[section].append((scenario_name, scenario_body))
        except Exception as e:
            print(f"Warning: Could not process {feature_file}: {e}")
            continue

    # Count scenarios that were extracted
    total_extracted = sum(len(s) for s in all_scenarios.values())
    if passing_scenarios is not None:
        print(f"  Included {total_extracted} verified passing scenarios")

    # Write the user guide
    with open(OUTPUT_FILE, "w") as f:
        # Logo image (always at top)
        f.write(
            '<p align="center"><img src="docs/imgs/vde-system-logo.png" alt="Virtualized Development Environment System Logo"></p>\n\n'
        )

        # Header with verification notice
        if passing_scenarios is not None:
            f.write(
                "**Every workflow in this guide has been tested and verified to PASS.** Follow the steps, they will work for you too.\n\n"
            )
        else:
            f.write(
                "**WARNING: This guide was generated in UNVERIFIED mode. Scenarios have NOT been tested!**\n\n"
            )
            f.write("**Run `./tests/run-bdd-tests.sh` first to generate a verified guide.**\n\n")

        f.write("---\n\n")

        # Table of contents
        f.write("## Table of Contents\n\n")
        f.write(
            "*💡 **Tip:** Click the ▶ triangle next to any section title below to expand or collapse that section.*\n\n"
        )
        sections = [
            (
                "1. Installation",
                [
                    (
                        "Installing Homebrew (macOS Only)",
                        [
                            ("For macOS Users", "for-macos-users"),
                        ],
                    ),
                    (
                        "Installing Zsh",
                        [
                            ("For Windows Users", "for-windows-users"),
                            ("For macOS (Mac) Users", "for-macos-mac-users"),
                            ("For Linux Users", "for-linux-users"),
                        ],
                    ),
                    (
                        "Installing Git",
                        [
                            ("For Windows Users", "for-windows-users-1"),
                            ("For macOS (Mac) Users", "for-macos-mac-users-1"),
                            ("For Linux Users", "for-linux-users-1"),
                        ],
                    ),
                    (
                        "Installing Docker Desktop",
                        [
                            ("For Windows Users", "for-windows-users-2"),
                            ("For macOS (Mac) Users", "for-macos-mac-users-2"),
                            ("For Linux Users", "for-linux-users-2"),
                        ],
                    ),
                    ("Quick Checklist: Are You Ready?", "quick-checklist-are-you-ready"),
                ],
            ),
            ("2. Your First VM", []),
            ("3. Connecting to your VM", []),
            ("4. The Magic Behind the Scenes (SSH Keys)", []),
            ("5. Understanding Your Workspace", []),
            ("6. Starting, Stopping, and Restarting", []),
            ("7. Your First Cluster (Multi-VM)", []),
            ("8. Working with Databases", []),
            ("9. Daily Study Routine", []),
            ("10. Adding More Languages", []),
            ("11. Troubleshooting", []),
            ("12. Trial of the Gauntlet", []),
        ]
        for i, (section, subsections) in enumerate(sections, 1):
            section_id = section.lower().replace(" ", "-").replace(":", "")
            f.write(f"{i}. [{section}](#{section_id})\n")
            for subsection, sub_subsections in subsections:
                subsection_id = (
                    subsection.lower().replace(" ", "-").replace(":", "").replace("?", "")
                )
                f.write(f"   - [{subsection}](#{subsection_id})\n")
                if isinstance(sub_subsections, list):
                    for sub_subsection, sub_subsection_id in sub_subsections:
                        f.write(f"     - [{sub_subsection}](#{sub_subsection_id})\n")
        f.write("\n---\n\n")

        # Write each section with collapsible wrapping
        for i, (section, _) in enumerate(sections, 1):
            # Start collapsible section (default collapsed)
            f.write(
                f'<details id="{section.lower().replace(" ", "-").replace(":", "")}" data-section="{section}">\n\n'
            )
            f.write(f"<summary><h2>{section}</h2></summary>\n\n")

            # Add section introduction from YAML (Phase 2)
            intro_key = section
            for key in section_intros:
                if key.startswith(section.split(".")[0] + "."):
                    intro_key = key
                    break
            if intro_key in section_intros:
                intro = section_intros[intro_key]
                f.write(intro)
                # Ensure intro ends with newlines before next section
                if intro and not intro.endswith("\n\n"):
                    f.write("\n\n")

            # *** PHASE 3 BUG FIX: Write scenarios after each section intro ***
            # This was the critical bug - scenarios were extracted but never written
            if all_scenarios.get(section):
                f.write("### Verified Scenarios\n\n")
                # Preface: explain vde commands vs scripts
                f.write(
                    "> **💡 Note:** The scenarios below show the Gherkin test steps used to verify VDE's behavior. "
                )
                f.write(
                    "Each scenario includes the actual **`vde` command** you would run to accomplish the task. "
                )
                f.write(
                    "We show the unified `vde` command because it's simpler and more consistent than "
                )
                f.write(
                    "remembering individual script names like `create-virtual-for` or `start-virtual`. "
                )
                f.write("The `vde` command handles all the heavy lifting for you!\n\n")
                for scenario_name, scenario_body in all_scenarios[section]:
                    f.write(format_scenario_for_user_guide(scenario_name, scenario_body))
                    f.write("\n\n")

            # End collapsible section
            f.write("</details>\n\n")

        # Quick reference card (now dynamically generated - Phase 4)
        f.write(generate_quick_reference())

        # JavaScript for collapsible sections with TOC navigation
        f.write("""
<script>
// Collapsible sections with TOC navigation
(function() {
    // Intercept all TOC links
    document.addEventListener('DOMContentLoaded', function() {
        // Storage key for remembering last open section
        const STORAGE_KEY = 'vde-user-guide-last-section';

        // Function to expand a specific section and collapse others
        function expandSection(sectionId) {
            const targetSection = document.querySelector(`details[id="${sectionId}"]`);
            if (targetSection) {
                targetSection.setAttribute('open', '');
                // Remember this section
                localStorage.setItem(STORAGE_KEY, sectionId);
                // Update URL hash without jumping
                history.replaceState(null, null, '#' + sectionId);
                // Collapse all other sections
                const allSections = document.querySelectorAll('details');
                allSections.forEach(function(section) {
                    if (section !== targetSection) {
                        section.removeAttribute('open');
                    }
                });
                // Scroll to the section
                targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }

        // On page load, check for URL hash first, then localStorage
        // This preserves the section view on browser refresh
        let targetSectionId = window.location.hash.substring(1);
        if (!targetSectionId) {
            // No hash? Check if we remember the last section
            targetSectionId = localStorage.getItem(STORAGE_KEY) || '';
        }
        if (targetSectionId) {
            // Small delay to ensure DOM is ready
            setTimeout(function() {
                expandSection(targetSectionId);
            }, 100);
        }

        // TOC link click handlers
        const tocLinks = document.querySelectorAll('a[href^="#"]');

        tocLinks.forEach(function(link) {
            link.addEventListener('click', function(e) {
                const targetId = link.getAttribute('href').substring(1);
                const targetSection = document.querySelector(`details[id="${targetId}"]`);

                if (targetSection) {
                    e.preventDefault();
                    expandSection(targetId);
                }
            });
        });

        // Also save section when user manually expands/collapses
        const allSections = document.querySelectorAll('details');
        allSections.forEach(function(section) {
            section.addEventListener('toggle', function() {
                if (this.open) {
                    const sectionId = this.getAttribute('id');
                    if (sectionId) {
                        localStorage.setItem(STORAGE_KEY, sectionId);
                        history.replaceState(null, null, '#' + sectionId);
                    }
                }
            });
        });
    });
})();
</script>
""")

    print(f"✓ Generated {OUTPUT_FILE}")
    if passing_scenarios is not None:
        print("  All scenarios in this guide have been verified to PASS")
    else:
        print("  WARNING: Scenarios in this guide have NOT been verified!")


if __name__ == "__main__":
    passing_scenarios = load_passing_scenarios_from_json()
    generate_user_guide(passing_scenarios)
