#!/usr/bin/env zsh
# Gap-filling tests: lib/vde-naming sanitization (path-traversal resistance)
: ${VDE_ROOT_DIR:?set VDE_ROOT_DIR to the vde-system checkout}
source "${0:A:h}/_harness.zsh"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-naming"

echo "== vde_normalize_name: table-driven"
typeset -A cases=(
    [python]=python
    [vde-python]=python
    [PYTHON]=python
    [Vde-Python]=python
    [vde-vde-x]=vde-x
    ['../../etc/passwd']=etcpasswd
    ['a/b']=ab
    ['a b']=ab
    ['py;rm']=pyrm
    ['']=''
    ['..']=''
)
for input expected in "${(@kv)cases}"; do
    assert_eq "normalize [$input]" "$expected" "$(vde_normalize_name "$input")"
done

echo "== normalized output can never contain a path separator or dot"
for evil in '../x' '..\x' '/abs' './x' '~root' '$HOME' 'a%2Fb'; do
    out="$(vde_normalize_name "$evil")"
    [[ "$out" != *[/.\\~\$]* ]]; assert_rc "no path chars from [$evil] -> [$out]" 0 $?
done

echo "== vde_validate_name"
vde_validate_name "python" >/dev/null;       assert_rc "plain name ok" 0 $?
vde_validate_name "vde-python" >/dev/null;   assert_rc "prefixed name ok" 0 $?
vde_validate_name "" >/dev/null;             assert_rc "empty rejected" 1 $?
vde_validate_name "my-vm-2" >/dev/null;      assert_rc "inner dashes and digits ok" 0 $?
vde_validate_name "vde-my-vm-2" >/dev/null;  assert_rc "prefixed name with inner dashes ok" 0 $?
vde_validate_name "Python" >/dev/null;       assert_rc "uppercase rejected" 1 $?
vde_validate_name "vde-Python" >/dev/null;   assert_rc "uppercase after prefix rejected" 1 $?
vde_validate_name "a_b" >/dev/null;          assert_rc "underscore rejected" 1 $?
vde_validate_name "../x" >/dev/null;         assert_rc "traversal rejected" 1 $?

echo "== container-name helpers are idempotent"
assert_eq "add prefix"      vde-go "$(vde_get_container_name go)"
assert_eq "keep prefix"     vde-go "$(vde_get_container_name vde-go)"
assert_eq "ssh host == container name" "$(vde_get_container_name go)" "$(vde_get_ssh_host go)"
assert_eq "hostname == container name" "$(vde_get_container_name go)" "$(vde_get_hostname go)"

echo "== CHARACTERIZATION"
echo "  normalize 'vde-' (prefix only)   -> [$(vde_normalize_name 'vde-')]"
echo "  get_container_name '' (empty)    -> [$(vde_get_container_name '')]"

finish
