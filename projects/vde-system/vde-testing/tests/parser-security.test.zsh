#!/usr/bin/env zsh
# Gap-filling tests: lib/vde-parser input-validation layer
#   contains_dangerous_chars, validate_plan_line, parse_flags
# None of these three functions has a unit test in tests/unit/ today.
#
# NOTE the INVERTED return convention of contains_dangerous_chars:
#   0 (VDE_SUCCESS)       => dangerous characters FOUND
#   3 (VDE_ERR_NOT_FOUND) => string is safe
: ${VDE_ROOT_DIR:?set VDE_ROOT_DIR to the vde-system checkout}
source "${0:A:h}/_harness.zsh"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vde-commands"
source "${VDE_ROOT_DIR}/lib/vde-parser"

echo "== contains_dangerous_chars: every listed metacharacter is caught"
typeset -a bad_inputs=(
    'a;b' 'a|b' 'a&b' 'a$b' 'a`b' 'a(b' 'a)b' 'a{b' 'a}b' 'a[b' 'a]b'
    'a<b' 'a>b' 'a!b' 'a#b' 'a*b' 'a?b' 'a\b' 'a"b'
)
for s in "${bad_inputs[@]}"; do
    contains_dangerous_chars "$s"; assert_rc "dangerous: [$s]" 0 $?
done

echo "== contains_dangerous_chars: ordinary values pass"
typeset -a good_inputs=( 'python' 'vde-postgres' 'rebuild=true nocache=false' 'start_vm' 'a-b_c.d' )
for s in "${good_inputs[@]}"; do
    contains_dangerous_chars "$s"; assert_rc "safe: [$s]" 3 $?
done

echo "== contains_dangerous_chars: realistic injection payloads"
for s in 'python; rm -rf /' '$(whoami)' '`id`' 'x && curl evil' 'x | nc host 1'; do
    contains_dangerous_chars "$s"; assert_rc "payload: [$s]" 0 $?
done

echo "== validate_plan_line: whitelist of keys"
for line in 'INTENT:start_vm' 'VM:python' 'FLAGS:rebuild=true' 'FILTER:running' \
            'CLUSTER_ACTION:start' 'CLUSTER_NAME:web'; do
    validate_plan_line "$line" 2>/dev/null; assert_rc "allowed: $line" 0 $?
done
validate_plan_line '' ; assert_rc "empty line is skipped" 0 $?
validate_plan_line 'EVIL:python' 2>/dev/null;   assert_rc "unknown key rejected" 2 $?
validate_plan_line 'intent:start_vm' 2>/dev/null; assert_rc "key match is case-sensitive" 2 $?
validate_plan_line 'VM:python; rm -rf /' 2>/dev/null; assert_rc "allowed key, injected value" 2 $?
validate_plan_line 'VM:$(id)' 2>/dev/null;      assert_rc "command substitution in value" 2 $?

echo "== parse_flags: defaults, valid values, rejection"
parse_flags "" ; assert_rc "empty flags ok" 0 $?
assert_eq "empty flags -> rebuild=false" false "$rebuild"
assert_eq "empty flags -> nocache=false" false "$nocache"

parse_flags "rebuild=true nocache=true"; assert_rc "both true" 0 $?
assert_eq "rebuild=true" true "$rebuild"; assert_eq "nocache=true" true "$nocache"

# State must be reset on each call (no leakage from the previous call)
parse_flags "nocache=true"; assert_rc "only nocache" 0 $?
assert_eq "rebuild reset to false on new call" false "$rebuild"

parse_flags "rebuild=yes" 2>/dev/null;   assert_rc "non-boolean value rejected" 2 $?
parse_flags "rebuild=TRUE" 2>/dev/null;  assert_rc "boolean is case-sensitive" 2 $?
parse_flags "force=true" 2>/dev/null;    assert_rc "unknown flag rejected" 2 $?
parse_flags "rebuild=true; id" 2>/dev/null; assert_rc "metacharacters rejected" 2 $?
parse_flags "rebuild=true force=true" 2>/dev/null; assert_rc "one bad flag among good ones" 2 $?

echo "== CHARACTERIZATION (documents current behavior, not asserted as correct)"
contains_dangerous_chars "a'b"; echo "  single quote        -> rc=$? (3 means NOT flagged)"
contains_dangerous_chars $'a\nb'; echo "  embedded newline    -> rc=$? (3 means NOT flagged)"
contains_dangerous_chars "a~b"; echo "  tilde               -> rc=$? (3 means NOT flagged)"
validate_plan_line $'VM:python\nEVIL:x' 2>/dev/null; validate_plan_line 'INTENT' 2>/dev/null; echo "  colon-less line 'INTENT' -> rc=$? (0 means accepted; value falls back to whole line)"
echo "  multi-line plan line -> rc=$? (0 means accepted as ONE line)"

finish
