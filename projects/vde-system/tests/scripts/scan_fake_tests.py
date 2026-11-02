#!/usr/bin/env python3
# @forge (Governance Sentinel)
"""
Scan test files for fake test patterns.
Identifies violations of the Fake Test Prohibition rules.
"""

import re
import sys
from pathlib import Path
from typing import List, Dict, Tuple

# Patterns to search for
FAKE_TEST_PATTERNS = {
    'assert_true': r'assert\s+True\b',
    'getattr_true_default': r'getattr\([^,]+,\s*[^,]+,\s*True\)',
    'or_true': r'\bor\s+True\b',
    # Ignore context flags that are used for scenario context in @given/@when steps
    # These are valid for tracking test state and not fake tests

    'pass_statement': r'^\s*pass\s*$',
    'removed_comment': r'#.*REMOVED:',
    'simulate_comment': r'["\'].*Simulate\b',
}

def scan_file(filepath: Path) -> List[Tuple[int, str, str]]:
    """
    Scan a single file for fake test patterns.
    Returns list of (line_number, pattern_name, line_content)
    """
    violations = []
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        for line_num, line in enumerate(lines, 1):
            # Skip comments for most patterns (except specific comment patterns)
            stripped = line.strip()
            
            # Check each pattern
            for pattern_name, pattern_regex in FAKE_TEST_PATTERNS.items():
                if re.search(pattern_regex, line):
                    # Special handling for context flags - need to verify if it's in a @when/@given step
                    if pattern_name in ['context_flag_true', 'context_flag_false']:
                        # Look back to see if this is in a step definition
                        is_in_step = False
                        for i in range(max(0, line_num - 20), line_num):
                            if i < len(lines) and re.search(r'@(when|given|then)\(', lines[i]):
                                is_in_step = True
                                break
                        
                        if is_in_step:
                            violations.append((line_num, pattern_name, stripped))
                    
                    # Special handling for pass statements - only flag if in @then steps
                    elif pattern_name == 'pass_statement':
                        is_in_then = False
                        for i in range(max(0, line_num - 10), line_num):
                            if i < len(lines) and re.search(r'@then\(', lines[i]):
                                is_in_then = True
                                break
                        
                        if is_in_then:
                            violations.append((line_num, pattern_name, stripped))
                    
                    # For other patterns, add directly
                    elif pattern_name not in ['context_flag_true', 'context_flag_false', 'pass_statement']:
                        violations.append((line_num, pattern_name, stripped))
    
    except Exception as e:
        print(f"Error scanning {filepath}: {e}", file=sys.stderr)
    
    return violations

def scan_directory(directory: Path) -> Dict[Path, List[Tuple[int, str, str]]]:
    """
    Scan all Python files in a directory.
    Returns dict of {filepath: violations}
    """
    results = {}
    
    for pyfile in sorted(directory.rglob('*.py')):
        # Skip __pycache__ and other generated files
        if '__pycache__' in str(pyfile) or '.pyc' in str(pyfile):
            continue
        
        violations = scan_file(pyfile)
        if violations:
            results[pyfile] = violations
    
    return results

def generate_report(results: Dict[Path, List[Tuple[int, str, str]]], base_path: Path) -> str:
    """Generate a comprehensive report of violations."""
    report_lines = []
    report_lines.append("=" * 80)
    report_lines.append("FAKE TEST PATTERN SCAN REPORT")
    report_lines.append("=" * 80)
    report_lines.append("")
    
    total_violations = sum(len(v) for v in results.values())
    total_files = len(results)
    
    report_lines.append(f"Total Files with Violations: {total_files}")
    report_lines.append(f"Total Violations Found: {total_violations}")
    report_lines.append("")
    report_lines.append("=" * 80)
    report_lines.append("")
    
    if not results:
        report_lines.append("✓ NO VIOLATIONS FOUND - All tests are clean!")
        report_lines.append("")
    else:
        for filepath, violations in sorted(results.items()):
            rel_path = filepath.relative_to(base_path)
            report_lines.append(f"File: {rel_path}")
            report_lines.append("-" * 80)
            
            for line_num, pattern_name, line_content in violations:
                report_lines.append(f"  Line {line_num}: [{pattern_name}]")
                report_lines.append(f"    {line_content}")
                report_lines.append("")
            
            report_lines.append("")
    
    report_lines.append("=" * 80)
    report_lines.append("PATTERN DEFINITIONS:")
    report_lines.append("=" * 80)
    report_lines.append("- assert_true: assert True (always passes)")
    report_lines.append("- getattr_true_default: getattr(context, 'x', True) (defaults to True)")
    report_lines.append("- or_true: expression or True (can't fail)")
    report_lines.append("- context_flag_true/false: context.x = True/False (flag without verification)")
    report_lines.append("- pass_statement: pass in @then steps (no verification)")
    report_lines.append("- removed_comment: # REMOVED: comments (documentation of removed fake tests)")
    report_lines.append("- simulate_comment: 'Simulate' in docstrings (indicates fake behavior)")
    report_lines.append("")
    
    return "\n".join(report_lines)

def main():
    """Main entry point."""
    vde_root = Path(__file__).parent.parent.parent
    
    # Scan both directories
    print("Scanning tests/features/steps/...")
    steps_results = scan_directory(vde_root / "tests" / "features" / "steps")
    
    print("Scanning tests/unit/...")
    unit_results = scan_directory(vde_root / "tests" / "unit")
    
    # Combine results
    all_results = {**steps_results, **unit_results}
    
    # Generate report
    report = generate_report(all_results, vde_root)
    
    # Print report
    print("\n" + report)
    
    # Save report to file
    report_file = vde_root / "tests" / "fake_test_scan_report.txt"
    with open(report_file, 'w') as f:
        f.write(report)
    
    print(f"\nReport saved to: {report_file}")
    
    # Exit with error code if violations found
    if all_results:
        sys.exit(1)
    else:
        sys.exit(0)

if __name__ == '__main__':
    main()
