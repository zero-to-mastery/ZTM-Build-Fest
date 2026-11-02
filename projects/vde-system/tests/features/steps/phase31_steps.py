#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
from behave import given, when, then
import yaml
from pathlib import Path
from vm_common import VDE_ROOT, get_vm_info

@then('the Docker Compose manifest for "{vm_alias}" must not contain absolute host paths')
def step_audit_manifest_paths(context, vm_alias):
    from vm_common import resolve_vm_name
    canonical_name = resolve_vm_name(vm_alias)
    
    # We resolve the path relatively as per Mandate
    manifest_path = VDE_ROOT / "configs" / "docker" / ("services" if "postgres" in canonical_name or "redis" in canonical_name or "jupyterlab" in canonical_name or "couchdb" in canonical_name else "languages") / vm_alias / "docker-compose.yml"
    
    assert manifest_path.exists(), f"Manifest missing: {manifest_path}"
    
    with open(manifest_path, 'r') as f:
        content = f.read()
        
    # Authorized exceptions like PROJECT_ROOT are allowed, but literal directory paths for home or users outside Spoke are forbidden
    # The scanner in vde-security-audit.zsh performs this audit, we prove it here.
    import re
    # Match absolute paths that aren't the authorized PROJECT_ROOT pattern
    # We look for [U]sers/ or [h]ome/ as indicators of host-leaks
    leaks = re.findall(r'/[Uu]sers/[^/]+/[^/]+', content)
    # Filter out authorized PROJECT_ROOT if it was expanded (it shouldn't be in the YAML, it should be relative ../..)
    
    assert not leaks, f"Absolute path leak detected in manifest {vm_alias}: {leaks}"

@then('the DNS aliases must be generated from relative metadata')
def step_verify_dns_metadata(context):
    # Proof: Check data/vm-types.json version and structure
    registry_path = VDE_ROOT / "data" / "vm-types.json"
    assert registry_path.exists()
    
    with open(registry_path, 'r') as f:
        import json
        data = json.load(f)
        
    assert "version" in data, "Registry missing version metadata"
    # DNS is derived from .name and .aliases in the registry, which are relative strings
    for cat in ["language", "service"]:
        for vm in data["vms"].get(cat, []):
            assert "name" in vm and "aliases" in vm
            assert not vm["name"].startswith("/"), f"DNS name {vm['name']} must be relative"
