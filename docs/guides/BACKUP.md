# backup:: - Automated Rolling Backups

The backup daemon automatically saves Y.Doc snapshots to `{FLOATTY_DATA_DIR}/backups/`.

## Data Loss Window

**< 1 hour** - backups run hourly by default.

## Commands

### backup::status

Show daemon health and timing.

```text
Backup Status
────────────────────────────────────────
Daemon:       Running ✓
Last backup:  2026-02-02 14:00:00 UTC (15m ago)
Next backup:  2026-02-02 15:00:00 UTC (in 45m)
Backup dir:   ~/.floatty-dev/backups/
Total files:  28 (142 MB)
```

### backup::list

List recent backups with sizes.

```text
Recent Backups (newest first)
────────────────────────────────────────
floatty-2026-02-02-140000.ydoc   4.7 MB   15m ago
floatty-2026-02-02-130000.ydoc   4.7 MB   1h ago
floatty-2026-02-02-120000.ydoc   4.6 MB   2h ago
```

### backup::trigger

Force an immediate backup (skip interval wait).

```text
Backup triggered: floatty-2026-02-02-141523.ydoc (4.7 MB)
```

### backup::config

Show current backup configuration.

```text
Backup Configuration
────────────────────────────────────────
Enabled:        true
Interval:       1 hour
Retain hourly:  24 backups
Retain daily:   7 backups
Retain weekly:  4 backups
```

### backup::restore \<filename\>

Restore from a specific backup. **Destructive** - requires `--confirm` flag.

```text
backup::restore floatty-2026-02-02-120000.ydoc --confirm
```

Shows confirmation warning first:

```text
⚠️ RESTORE WARNING
────────────────────────────────────────
This will replace current state with:
  floatty-2026-02-02-120000.ydoc (4.6 MB)

Type "backup::restore floatty-2026-02-02-120000.ydoc --confirm" to proceed.
```

## Configuration

Edit `~/.floatty/config.toml` (or `~/.floatty-dev/config.toml` for dev):

```toml
[backup]
enabled = true              # Enable/disable daemon
interval_hours = 1          # How often to backup
retain_hourly = 24          # Hours to keep hourly backups (max 24)
retain_daily = 7            # Days to keep daily backups
retain_weekly = 4           # Weeks to keep weekly backups
```

## Retention Policy

Backups are tiered by age:

| Tier | Age | Kept |
|------|-----|------|
| Hourly | < 24h | All (up to 24) |
| Daily | 24h - 7d | One per day (00:xx UTC) |
| Weekly | 7d - 28d | One per week (Sunday) |
| Beyond | > 28d | Deleted |

## Backup Directory

```
~/.floatty/backups/           # Release builds
~/.floatty-dev/backups/       # Dev builds
```

Files named: `floatty-YYYY-MM-DD-HHmmss.ydoc`

## API Endpoints

For scripts/automation:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/backup/status` | GET | Daemon status |
| `/api/v1/backup/list` | GET | List backups |
| `/api/v1/backup/trigger` | POST | Force backup |
| `/api/v1/backup/restore` | POST | Restore (body: `{"filename": "..."}`) |
| `/api/v1/backup/config` | GET | Show config |

Example:
```bash
KEY=$(grep api_key ~/.floatty-dev/config.toml | cut -d'"' -f2)
PORT=$(grep server_port ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ')
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/backup/status"
```

## Troubleshooting

**"Backups not enabled"** - Check `[backup].enabled = true` in config

**Immediate backup on start** - Normal if last backup > interval old

**Missing backups** - Retention may have pruned them; check logs:
```bash
jq 'select(.fields.message | contains("Backup"))' ~/.floatty-dev/logs/floatty.*.jsonl
```
