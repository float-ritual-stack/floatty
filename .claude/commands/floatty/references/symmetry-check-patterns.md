# Symmetry Check Grep Patterns (FLO-317)

Run against the relevant scope (full codebase, diff, or planned changes).

## Path Resolution
All `data_dir()` / path functions should use `#[cfg]` or `DataPaths`.
```bash
grep -rn 'data_dir\|default_.*path\|config_path' src-tauri/ --include='*.rs'
```

## Config Loading / Saving
Should use `load_from`/`save_to` with explicit paths.
```bash
grep -rn '\.load()\|\.save()\|load_from\|save_to' src-tauri/ --include='*.rs'
```

## Deprecated Methods
```bash
grep -rn 'AggregatorConfig::load()\|\.save()' src-tauri/src/ --include='*.rs' | grep -v '#\[deprecated'
```

## Handler Registration
All handlers should follow same pattern.
```bash
grep -rn 'registerHandler\|executeHandler' src/ --include='*.ts'
```

## Hardcoded Paths
Should go through `DataPaths::default_root()`.
```bash
grep -rn '\.join(".floatty")' src-tauri/ --include='*.rs'
```

## Hook Patterns
```bash
grep -rn 'blockEventBus\|emit_change\|on_change' src/ --include='*.ts'
```

## Red Flags

- [ ] Function has siblings doing the same thing a different way
- [ ] `#[cfg]` gate added somewhere but similar code nearby is unguarded
- [ ] Deprecated methods called in non-deprecated paths
- [ ] Hardcoded path that should go through `DataPaths::default_root()`
- [ ] Serialization format changed but readers expect old format
- [ ] Path/URL fixed in one place but hardcoded elsewhere

## Release Assertions

- [ ] No new hardcoded `~/.floatty` or `~/.floatty-dev` outside `paths.rs`
- [ ] Preflight assertions present in `lib.rs` and `main.rs`
- [ ] No new `data_dir()` functions without `#[cfg(debug_assertions)]` gate
- [ ] `cargo test -p floatty -- no_unguarded_floatty_paths` passes
