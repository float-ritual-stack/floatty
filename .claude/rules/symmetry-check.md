# Symmetry Check (Hotfix Drift Prevention)

When a feature or fix changes HOW something works, other code doing the same thing the old way becomes a latent bug.

## The Reflex

**Before implementing any change to a shared pattern, grep for all other instances of that pattern.**

Examples of "shared patterns" that drift:
- Path resolution (`data_dir()`, `default_*_path()`, `config_path()`)
- Config serialization (any `save()` / `load()` pair)
- Auth/header injection
- Error handling shape (retry logic, fallback behavior)
- Port/URL construction
- Logging format/destination

## When Planning

Ask: "What other code does the same thing I'm about to change?"

```bash
# Find siblings of the pattern you're modifying
grep -rn 'data_dir\|default_.*path\|config_path' src-tauri/ --include='*.rs'
grep -rn 'loadConfig\|saveConfig\|getConfig' src/ --include='*.ts'
```

If you find siblings, your plan MUST include them — even if they "work fine today."

## When Reviewing (Pre-PR)

For each file in the diff, ask: "Did I change a pattern that exists elsewhere?"

Red flags:
- You modified a function but there's a similar function in another module
- You added a `#[cfg]` gate but similar code nearby doesn't have one
- You fixed a path in one place but the same path is hardcoded elsewhere
- You deprecated a method but didn't mark it `#[deprecated]`

## The FLO-317 Lesson

Two isolation strategies coexisted. One function got upgraded, siblings didn't.
`config.save()` serializes the ENTIRE struct — so wrong PATH + any save = silent corruption.

Pattern: when you introduce a new mechanism, grep for ALL code using the OLD mechanism.
