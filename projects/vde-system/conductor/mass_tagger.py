#!/usr/bin/env python3
# @shared-law (Forge Component)
import os
import re
from pathlib import Path

# The VDE Root - Calculated relative to the script location
VDE_ROOT = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

def get_tag_info(file_path):
    rel_path = str(file_path.relative_to(VDE_ROOT))
    
    # FORGE: Governance, CI, Tests, Auditors
    if any(x in rel_path for x in [".github/", ".gemini", "githooks/", "tests/", "bin/vde-enforce-uap", "bin/vde-security", "bin/vde-health"]):
        return "@forge", "Governance Sentinel"
    
    # SHARED-LAW: Foundation, Constants, Documentation
    if any(x in rel_path for x in ["lib/vde-constants", "lib/vde-errors", "lib/vde-shell-compat", "docs/", "templates/"]):
        return "@shared-law", "Sovereign Law"
        
    # ARMOR: Engine, Naming, Docker, Hydration
    if any(x in rel_path for x in ["bin/", "lib/", "scripts/", "data/", "env-files/"]):
        return "@armor", "Engine Core"

    return "@shared-law", "Forge Component"

def get_comment_syntax(file_path, tag, effect):
    ext = file_path.suffix.lower()
    if ext in [".zsh", ".sh", ".py", ".yml", ".yaml", ".env", ".conf", ""]:
        return f"# {tag} ({effect})\n"
    if ext in [".md", ".html", ".xml"]:
        return f"<!-- {tag} ({effect}) -->\n"
    if ext in [".json"]:
        return f'  "{tag}": "({effect})",\n'
    return f"# {tag} ({effect})\n"

def process_file(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except: return False

    if not lines: return False

    # PURGE: Remove any existing tags in first 5 lines
    tag_pattern = re.compile(r'@(armor|forge|shared-law)')
    new_lines = []
    for i, line in enumerate(lines):
        if i < 5 and tag_pattern.search(line):
            continue
        new_lines.append(line)

    tag, effect = get_tag_info(file_path)
    comment_line = get_comment_syntax(file_path, tag, effect)

    # RE-INSERT at Line 2
    if file_path.suffix == ".json":
        for i, line in enumerate(new_lines):
            if '{' in line:
                new_lines.insert(i+1, comment_line)
                break
    else:
        if len(new_lines) > 1:
            new_lines.insert(1, comment_line)
        else:
            new_lines.append(comment_line)

    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    return True

def main():
    tagged = 0
    for root, dirs, files in os.walk(VDE_ROOT):
        dirs[:] = [d for d in dirs if d not in ['.git', '.cache', 'logs', 'node_modules', '__pycache__', 'projects']]
        for f in files:
            if f in ['README.md', 'vde_exec.log', 'fifo_test.log']: continue
            if process_file(Path(root) / f): tagged += 1
    print(f"Purified and Tagged: {tagged} files")

if __name__ == "__main__": main()
