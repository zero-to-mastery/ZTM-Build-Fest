# Keybindings

Rules for adding or changing a key in orb.

- **Bind only keys the maintainer asked for.** A key exists because it is listed in [docs/keys.md](../keys.md#keys) or in an approved plan. Don't add a "handy" extra, and don't take a key nobody asked for.
- **orb's direct keys use Alt.** They are matched in `alt_route` (crates/orb-tui/src/keymap.rs:366). Shift is ignored there, so `Alt +` works however the terminal reports it.
  - On Linux there is nothing to set up.
  - On macOS, Option is often taken by the system or a window manager. The user either sets `macos_option_as_alt yes` in kitty.conf, or adds one kitty map line per key that turns Cmd into Alt, such as `map cmd+h send_key alt+h`. docs/keys.md's Setup section lists every line, and install.sh writes the same lines.
  - **When you add an Alt key, add its Cmd map line to docs/keys.md and its key to the loop in install.sh's kitty_keys.**
- **Never bind Super.** orb reads no Super key, and the Mac setup above depends on Cmd reaching orb as Alt.
- **Everything else goes behind the `<C-g>` leader.** The which-key popup labels each key with its intent's `Display` text (crates/orb-domain/src/intent.rs:239), so give a new intent a short label.
- **orb expects kitty.** Some keys only work with the kitty keyboard protocol. `<C-[>` and `<C-]>` need its disambiguate flag, or Ctrl+[ arrives as a plain Esc (`jump_route`, keymap.rs:355).
- **Bind each key in the right group of scopes** (`keymap`, keymap.rs:181). A `Scope` is the side with the keys (sidebar or pane), the row they act on (a session's card, an agent row, a colony's colonists row, or none) and the session's kind (keymap.rs:55-85); each group of keys is bound in the scopes its filter picks. A key bound in the wrong group fires where it shouldn't, or not at all.
- **A key that does nothing for one kind of session goes in `hidden`** (keymap.rs:155-167), the one place a kind leaves keys unbound. A new kind is one `SessionKind` variant plus one arm there.
- **Update keymap/bindings.txt when you change a key on purpose.** `every_scope_keeps_its_bindings` compares every scope's keys and popup text with it, so any other change to the bindings fails the test.
- **Add a keymap test case next to the others** for the new key, the way `ctrl_brackets_jump_in_the_sidebar_and_in_a_pane` covers the jump keys (keymap.rs:1558).
