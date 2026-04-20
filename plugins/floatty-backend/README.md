# floatty-backend plugin

Shell helpers + Claude Code skill for working with the [floatty-server](../../apps/floatty/src-tauri/floatty-server) REST API. Block CRUD, search, daily notes, and the semantic endpoints from [[FLO-652]].

## What's inside

- `skills/floatty-backend/SKILL.md` — the skill description + mental model that Claude Code loads when you use the plugin.
- `scripts/` — bash functions (`floatty_block_*`, `floatty_search`, `floatty_daily_*`, etc.) that wrap the API. Sourced on demand by the skill.
- `references/` — expanded docs (`api-reference.md`, `helpers.md`, `workflows.md`, `anti-patterns.md`) loaded via progressive disclosure when the task needs them.

## Install

This plugin lives in the floatty monorepo's marketplace. From a Claude Code session:

```bash
# Add the whole floatty marketplace (one-time)
/plugin marketplace add float-ritual-stack/floatty

# Install the backend plugin
/plugin install floatty-backend@floatty-plugins
```

The marketplace is declared in the repo root at `.claude-plugin/marketplace.json`, so any future floatty plugin (janitor, page-sort, view-builders) ships from the same catalog.

## Configure

The scripts read two environment variables (both auto-detected from `~/.floatty-dev/config.toml` if present):

- `FLOATTY_URL` — defaults to `http://127.0.0.1:8765` (release) or `http://127.0.0.1:33333` (dev)
- `FLOATTY_API_KEY` — the `api_key` field from the TOML config

## Bug history

- **[[FLO-636]]** (fixed in-skill): the previous `floatty_daily_find_or_create` ran a heading search for `## $date` and, on miss, created a `## $date` root block — wrong shape AND wrong location (pages live under `pages::` as `# $date`). Replaced with a direct `GET /api/v1/daily/:date` lookup that returns a clean error when the daily note doesn't exist.
- **[[FLO-652]]** (pending release): once the new `POST /api/v1/pages/:name` + `POST /api/v1/daily/:date/append` endpoints ship in a release binary, a follow-up PR will add `floatty_daily_append_via_api` for autocreate-on-missing without the UI round-trip.

## Local development

```bash
# Test the plugin without installing it
claude --plugin-dir plugins/floatty-backend

# Validate the marketplace JSON
claude plugin validate .
```
