#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wasm_source="$project_root/target/wasm32-unknown-unknown/release/kin.wasm"
wasm_destination="$project_root/web/wasm/kin_engine.wasm"

cargo build --manifest-path "$project_root/Cargo.toml" --target wasm32-unknown-unknown --release
mkdir -p "$(dirname -- "$wasm_destination")"
cp "$wasm_source" "$wasm_destination"