//! Backup daemon for automated Y.Doc snapshots.
//!
//! Runs hourly (configurable), saving Y.Doc state to `{FLOATTY_DATA_DIR}/backups/`.
//! Retention policy: hourly for 24h, daily for 7d, weekly for 4w.

use crate::config::{data_dir, BackupConfig};
use chrono::Utc;
use floatty_core::YDocStore;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;

/// Backup daemon state
pub struct BackupDaemon {
    store: Arc<YDocStore>,
    config: BackupConfig,
    backup_dir: PathBuf,
}

/// Info about a single backup file
#[derive(Debug, Clone)]
pub struct BackupInfo {
    pub filename: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub created: SystemTime,
}

/// Daemon status for API
#[derive(Debug, Clone)]
pub struct DaemonStatus {
    pub running: bool,
    pub last_backup: Option<SystemTime>,
    pub next_backup: Option<SystemTime>,
    pub backup_count: usize,
    pub total_size_bytes: u64,
}

impl BackupDaemon {
    /// Create a new backup daemon
    pub fn new(store: Arc<YDocStore>, config: BackupConfig, backup_dir: PathBuf) -> Self {
        Self {
            store,
            config,
            backup_dir,
        }
    }

    /// Start the backup daemon as a background task
    /// Takes Arc<Self> so the same instance is used for both API and background task
    pub fn start(self: Arc<Self>) -> JoinHandle<()> {
        let daemon = Arc::clone(&self);
        tokio::spawn(async move {
            daemon.run().await;
        })
    }

    /// Main daemon loop
    async fn run(&self) {
        // Check if immediate backup needed (last backup > interval old)
        if self.should_backup_immediately() {
            tracing::info!("Last backup is stale, running immediate backup");
            self.run_backup().await;
        }

        // Calculate interval in seconds (always hours)
        // For testing, use FLOATTY_BACKUP_INTERVAL_SECS env var to override
        let interval_secs = std::env::var("FLOATTY_BACKUP_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(self.config.interval_hours * 3600);

        let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
        interval.tick().await; // First tick is immediate (skip it)

        loop {
            interval.tick().await;
            self.run_backup().await;
        }
    }

    /// Run a single backup
    async fn run_backup(&self) {
        let start = Instant::now();

        match self.store.get_full_state() {
            Ok(state) => {
                let timestamp = Self::timestamp();
                let filename = format!("floatty-{}.ydoc", timestamp);
                let path = self.backup_dir.join(&filename);

                match tokio::fs::write(&path, &state).await {
                    Ok(_) => {
                        let duration_ms = start.elapsed().as_millis() as u64;
                        tracing::info!(
                            target: "floatty_server::backup",
                            bytes = state.len(),
                            file = %filename,
                            duration_ms = duration_ms,
                            "Backup completed"
                        );
                        self.apply_retention();
                    }
                    Err(e) => {
                        tracing::error!(
                            target: "floatty_server::backup",
                            error = %e,
                            path = %path.display(),
                            "Backup write failed"
                        );
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    target: "floatty_server::backup",
                    error = %e,
                    "Backup state read failed"
                );
            }
        }
    }

    /// Generate UTC timestamp for filename: YYYY-MM-DD-HHmmss
    fn timestamp() -> String {
        Utc::now().format("%Y-%m-%d-%H%M%S").to_string()
    }

    /// Check if we should backup immediately (last backup is stale)
    fn should_backup_immediately(&self) -> bool {
        let backups = match self.list_backups() {
            Ok(b) => b,
            Err(_) => return true, // No backups dir = definitely backup
        };

        if backups.is_empty() {
            return true;
        }

        // Find most recent backup
        let most_recent = backups.iter()
            .max_by_key(|b| b.created);

        match most_recent {
            Some(backup) => {
                let age = SystemTime::now()
                    .duration_since(backup.created)
                    .unwrap_or(Duration::MAX);

                // Stale if older than interval (interval_hours is always in hours)
                let threshold = Duration::from_secs(self.config.interval_hours * 3600);

                age > threshold
            }
            None => true,
        }
    }

    /// List all backup files
    pub fn list_backups(&self) -> std::io::Result<Vec<BackupInfo>> {
        let mut backups = Vec::new();

        if !self.backup_dir.exists() {
            return Ok(backups);
        }

        for entry in std::fs::read_dir(&self.backup_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.extension().map(|e| e == "ydoc").unwrap_or(false) {
                let metadata = entry.metadata()?;
                let filename = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                backups.push(BackupInfo {
                    filename,
                    path,
                    size_bytes: metadata.len(),
                    created: metadata.modified().unwrap_or(UNIX_EPOCH),
                });
            }
        }

        // Sort by created time, newest first
        backups.sort_by(|a, b| b.created.cmp(&a.created));
        Ok(backups)
    }

    /// Apply retention policy - prune old backups by tier
    fn apply_retention(&self) {
        let backups = match self.list_backups() {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(
                    target: "floatty_server::backup",
                    error = %e,
                    "Failed to list backups for retention"
                );
                return;
            }
        };

        let now = SystemTime::now();

        // Tier boundaries
        let hourly_cutoff = now - Duration::from_secs(self.config.retain_hourly as u64 * 3600);
        let daily_cutoff = now - Duration::from_secs(self.config.retain_daily as u64 * 86400);
        let weekly_cutoff = now - Duration::from_secs(self.config.retain_weekly as u64 * 7 * 86400);

        // Bucket backups by tier
        let mut hourly: Vec<&BackupInfo> = Vec::new();
        let mut daily: Vec<&BackupInfo> = Vec::new();
        let mut weekly: Vec<&BackupInfo> = Vec::new();
        let mut expired: Vec<&BackupInfo> = Vec::new();

        for backup in &backups {
            if backup.created >= hourly_cutoff {
                hourly.push(backup);
            } else if backup.created >= daily_cutoff {
                daily.push(backup);
            } else if backup.created >= weekly_cutoff {
                weekly.push(backup);
            } else {
                expired.push(backup);
            }
        }

        // Keep one per day in daily tier (prefer earliest in each day = 00:xx)
        let daily_to_delete = Self::filter_tier_keep_one_per_day(&daily);

        // Keep one per week in weekly tier (prefer Sunday)
        let weekly_to_delete = Self::filter_tier_keep_one_per_week(&weekly);

        // Delete expired and filtered backups
        let mut deleted_count = 0;

        for backup in expired.iter().chain(daily_to_delete.iter()).chain(weekly_to_delete.iter()) {
            if let Err(e) = std::fs::remove_file(&backup.path) {
                tracing::warn!(
                    target: "floatty_server::backup",
                    error = %e,
                    file = %backup.filename,
                    "Failed to delete backup"
                );
            } else {
                deleted_count += 1;
            }
        }

        if deleted_count > 0 {
            tracing::info!(
                target: "floatty_server::backup",
                deleted_count = deleted_count,
                "Retention pruned old backups"
            );
        }
    }

    /// Filter daily tier: keep one backup per calendar day (UTC)
    fn filter_tier_keep_one_per_day<'a>(backups: &[&'a BackupInfo]) -> Vec<&'a BackupInfo> {
        use std::collections::HashMap;

        // Group by date (YYYY-MM-DD from filename)
        let mut by_date: HashMap<String, Vec<&'a BackupInfo>> = HashMap::new();
        for backup in backups {
            // Extract date from filename: floatty-YYYY-MM-DD-HHmmss.ydoc
            if let Some(date) = backup.filename.strip_prefix("floatty-").and_then(|s| s.get(0..10)) {
                by_date.entry(date.to_string()).or_default().push(backup);
            }
        }

        // Keep earliest backup per day (00:xx preferred), mark rest for deletion
        let mut to_delete = Vec::new();
        for (_date, mut day_backups) in by_date {
            day_backups.sort_by(|a, b| a.created.cmp(&b.created)); // Oldest first
            // Skip first (keep it), delete rest
            to_delete.extend(day_backups.into_iter().skip(1));
        }

        to_delete
    }

    /// Filter weekly tier: keep one backup per calendar week (Sunday preferred)
    fn filter_tier_keep_one_per_week<'a>(backups: &[&'a BackupInfo]) -> Vec<&'a BackupInfo> {
        use std::collections::HashMap;

        // Group by ISO week (year-week)
        let mut by_week: HashMap<String, Vec<&'a BackupInfo>> = HashMap::new();
        for backup in backups {
            // Parse date from filename and compute week
            if let Some(date_str) = backup.filename.strip_prefix("floatty-").and_then(|s| s.get(0..10)) {
                let week_key = Self::date_to_week_key(date_str);
                by_week.entry(week_key).or_default().push(backup);
            }
        }

        // Keep one per week (prefer Sunday = day 0), mark rest for deletion
        let mut to_delete = Vec::new();
        for (_week, mut week_backups) in by_week {
            // Sort by how close to Sunday (prefer day of week = 0)
            week_backups.sort_by(|a, b| {
                let a_dow = Self::day_of_week_from_filename(&a.filename);
                let b_dow = Self::day_of_week_from_filename(&b.filename);
                a_dow.cmp(&b_dow)
            });
            // Skip first (keep it), delete rest
            to_delete.extend(week_backups.into_iter().skip(1));
        }

        to_delete
    }

    /// Convert date string (YYYY-MM-DD) to week key (YYYY-WNN)
    fn date_to_week_key(date_str: &str) -> String {
        // Simple approach: use the date string's first 7 chars (YYYY-MM) + week of month
        // For accurate ISO weeks we'd need full date math, but this is close enough
        let parts: Vec<&str> = date_str.split('-').collect();
        if parts.len() >= 3 {
            let year = parts[0];
            let month = parts[1];
            let day: u32 = parts[2].parse().unwrap_or(1);
            let week_of_month = (day - 1) / 7;
            format!("{}-{}-W{}", year, month, week_of_month)
        } else {
            date_str.to_string()
        }
    }

    /// Get day of week from filename (0=Sun, 6=Sat) - approximation
    fn day_of_week_from_filename(filename: &str) -> u32 {
        // Extract date and compute day of week using Zeller's formula
        if let Some(date_str) = filename.strip_prefix("floatty-").and_then(|s| s.get(0..10)) {
            let parts: Vec<&str> = date_str.split('-').collect();
            if parts.len() >= 3 {
                let year: i32 = parts[0].parse().unwrap_or(2000);
                let month: i32 = parts[1].parse().unwrap_or(1);
                let day: i32 = parts[2].parse().unwrap_or(1);

                // Zeller's congruence (adjusted for Sunday = 0)
                let m = if month < 3 { month + 12 } else { month };
                let y = if month < 3 { year - 1 } else { year };
                let k = y % 100;
                let j = y / 100;
                let h = (day + (13 * (m + 1)) / 5 + k + k / 4 + j / 4 - 2 * j) % 7;
                // Convert to 0=Sunday
                ((h + 6) % 7) as u32
            } else {
                7 // Invalid = sort last
            }
        } else {
            7
        }
    }

    /// Get current daemon status
    pub fn get_status(&self) -> DaemonStatus {
        let backups = self.list_backups().unwrap_or_default();
        let last_backup = backups.first().map(|b| b.created);
        let total_size: u64 = backups.iter().map(|b| b.size_bytes).sum();

        // Calculate next backup time (interval_hours is always in hours)
        let next_backup = last_backup.map(|last| {
            let interval = Duration::from_secs(self.config.interval_hours * 3600);
            last + interval
        });

        DaemonStatus {
            running: true, // If we can call this, daemon is running
            last_backup,
            next_backup,
            backup_count: backups.len(),
            total_size_bytes: total_size,
        }
    }

    /// Trigger an immediate backup (for API)
    pub async fn trigger_backup(&self) -> Result<BackupInfo, String> {
        let start = Instant::now();

        let state = self.store.get_full_state()
            .map_err(|e| format!("Failed to get state: {}", e))?;

        let timestamp = Self::timestamp();
        let filename = format!("floatty-{}.ydoc", timestamp);
        let path = self.backup_dir.join(&filename);

        tokio::fs::write(&path, &state).await
            .map_err(|e| format!("Failed to write backup: {}", e))?;

        let duration_ms = start.elapsed().as_millis() as u64;
        tracing::info!(
            target: "floatty_server::backup",
            bytes = state.len(),
            file = %filename,
            duration_ms = duration_ms,
            "Manual backup triggered"
        );

        // Apply retention after manual backup too
        self.apply_retention();

        Ok(BackupInfo {
            filename,
            path,
            size_bytes: state.len() as u64,
            created: SystemTime::now(),
        })
    }

    /// Get the backup directory path
    pub fn backup_dir(&self) -> &PathBuf {
        &self.backup_dir
    }

    /// Get the config
    pub fn config(&self) -> &BackupConfig {
        &self.config
    }
}

/// Create the backup directory path for an outline.
/// - "default" → `{data_dir}/backups/` (legacy path, unchanged)
/// - other     → `{data_dir}/outlines/{name}/backups/`
pub fn backup_dir_for(outline_name: &str) -> PathBuf {
    if outline_name == "default" {
        data_dir().join("backups")
    } else {
        data_dir().join("outlines").join(outline_name).join("backups")
    }
}

/// Create the backup directory path (legacy convenience — default outline only)
pub fn backup_dir() -> PathBuf {
    backup_dir_for("default")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timestamp_format() {
        let ts = BackupDaemon::timestamp();
        // Should be YYYY-MM-DD-HHmmss format
        assert_eq!(ts.len(), 17);
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "-");
    }

    #[test]
    fn test_day_of_week() {
        // 2026-02-01 is a Sunday
        let dow = BackupDaemon::day_of_week_from_filename("floatty-2026-02-01-120000.ydoc");
        assert_eq!(dow, 0); // Sunday

        // 2026-02-02 is a Monday
        let dow = BackupDaemon::day_of_week_from_filename("floatty-2026-02-02-120000.ydoc");
        assert_eq!(dow, 1); // Monday
    }
}
