//! floatty-server: Standalone HTTP server for floatty block store.
//!
//! Run with:
//!   cargo run -p floatty-server
//!
//! Or install and run:
//!   cargo install --path src-tauri/floatty-server
//!   floatty-server

use axum::{extract::DefaultBodyLimit, http::Method, middleware, routing::get, Router};
use floatty_core::{HookSystem, YDocStore};
use floatty_server::{
    api, auth,
    backup::{self, BackupDaemon},
    config::{BackupConfig, ServerConfig},
    start_heartbeat, ws, OutlineManager, WsBroadcaster,
};
use opentelemetry::trace::TracerProvider;
use opentelemetry::KeyValue;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::{logs::SdkLoggerProvider, trace::SdkTracerProvider, Resource};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Build profile tag surfaced as the `deployment.environment` OTel resource
/// attribute → `deployment_environment` Loki label. Lets you query dev vs
/// release separately: `{service_name="floatty-server",deployment_environment="dev"}`.
#[cfg(debug_assertions)]
const BUILD_PROFILE: &str = "dev";
#[cfg(not(debug_assertions))]
const BUILD_PROFILE: &str = "release";

/// OTel resource shared by both log and trace providers.
fn otel_resource() -> Resource {
    Resource::builder()
        .with_service_name("floatty-server")
        .with_attribute(KeyValue::new(
            "service.version",
            env!("CARGO_PKG_VERSION"),
        ))
        .with_attribute(KeyValue::new("deployment.environment", BUILD_PROFILE))
        .build()
}

/// Build an OTLP log exporter + provider when an endpoint is configured.
///
/// Returns None if the endpoint is None or the exporter fails to build. In both
/// cases the server continues with file + stdout logging only. This keeps floatty
/// functional on untrusted networks and when the collector is unreachable — the
/// local JSONL file is always the source of truth, OTLP is fire-and-forget shipping.
fn init_otlp_logs(endpoint: Option<&str>) -> Option<SdkLoggerProvider> {
    let endpoint = endpoint?;

    let exporter = match LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!("OTLP log exporter build failed: {e}. Continuing without OTLP export.");
            return None;
        }
    };

    Some(
        SdkLoggerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(otel_resource())
            .build(),
    )
}

/// Build an OTLP trace exporter + provider. Shares the same endpoint as logs —
/// the collector (Alloy) routes logs to Loki and traces to Tempo.
///
/// Uses the base endpoint (not signal-specific) so the OTLP client appends
/// `/v1/traces` automatically, same as the log exporter appends `/v1/logs`.
fn init_otlp_traces(endpoint: Option<&str>) -> Option<SdkTracerProvider> {
    let endpoint = endpoint?;

    // Traces go to the base OTLP endpoint (collector routes to Tempo).
    // Strip /v1/logs suffix if present — the SDK appends /v1/traces itself.
    let base = endpoint.trim_end_matches("/v1/logs");

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(base)
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!("OTLP trace exporter build failed: {e}. Continuing without trace export.");
            return None;
        }
    };

    Some(
        SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(otel_resource())
            .build(),
    )
}

/// Providers returned from setup_logging — caller holds them alive for the
/// duration of the process. Dropping them flushes pending exports.
struct OtelProviders {
    _logger: Option<SdkLoggerProvider>,
    _tracer: Option<SdkTracerProvider>,
}

fn setup_logging(log_dir: &std::path::Path, otlp_endpoint: Option<&str>) -> OtelProviders {
    // JSON file layer — rotates daily, appends to same files as Tauri process
    let file_appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("floatty")
        .filename_suffix("jsonl")
        .build(log_dir)
        .expect("Failed to create log file appender");

    // Match src-tauri/src/lib.rs field set exactly — both processes append to
    // the same floatty.YYYY-MM-DD.jsonl files, so consistent schemas keep jq
    // queries and log parsers from tripping on missing fields.
    let file_layer = fmt::layer()
        .json()
        .with_writer(file_appender)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_file(true)
        .with_line_number(true);

    // Include floatty_core + floatty_startup (target override) so hook system phases are visible.
    // EnvFilter matches on the log target, not crate path — the `target: "floatty_startup"` override
    // in hooks/system.rs bypasses the crate-path filter and needs its own entry.
    //
    // hyper/reqwest filtered to warn to prevent OTLP export telemetry-induced-telemetry loops
    // (the HTTP client used by the OTLP exporter emits its own tracing events).
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(
            "floatty_server=info,floatty_core=info,floatty_startup=info,\
             tower_http=warn,hyper=warn,reqwest=warn,opentelemetry=off",
        )
    });

    // Optional OTLP log layer — None if endpoint unset or exporter build fails.
    // Option<L> implements Layer<S> for any L: Layer<S>, so None is a no-op in the chain.
    let logger_provider = init_otlp_logs(otlp_endpoint);
    let otlp_log_layer = logger_provider
        .as_ref()
        .map(OpenTelemetryTracingBridge::new);

    // Optional OTLP trace layer — bridges tracing::instrument spans → OTLP trace spans.
    // Shares the same base endpoint; collector routes traces to Tempo.
    let tracer_provider = init_otlp_traces(otlp_endpoint);
    let otlp_trace_layer = tracer_provider
        .as_ref()
        .map(|tp| tracing_opentelemetry::layer().with_tracer(tp.tracer("floatty-server")));

    // Compose via cfg split rather than Option<stdout> — fmt::layer() infers its subscriber
    // type from context, and pinning it to Option<Layer<Registry>> breaks composition once
    // the chain is already Layered<...>.
    #[cfg(debug_assertions)]
    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(otlp_log_layer)
        .with(otlp_trace_layer)
        .with(fmt::layer().with_target(true).with_ansi(true))
        .init();

    #[cfg(not(debug_assertions))]
    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(otlp_log_layer)
        .with(otlp_trace_layer)
        .init();

    OtelProviders {
        _logger: logger_provider,
        _tracer: tracer_provider,
    }
}

#[tokio::main]
async fn main() {
    // Load config first — otlp_endpoint lives in config.toml, and we need it
    // before setup_logging() so the OTLP layer can be wired. Any config parse
    // errors will go to eprintln (tracing subscriber not up yet).
    let config = ServerConfig::load();

    // Initialize structured JSONL logging to same files as Tauri process.
    // OTLP endpoint resolution order (first match wins):
    //   1. OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (signal-specific, full URL, used as-is)
    //   2. OTEL_EXPORTER_OTLP_ENDPOINT      (general base URL; we append /v1/logs)
    //   3. config.otlp_endpoint             (floatty config.toml, used as-is)
    //
    // The signal-specific env var is a full URL to the logs endpoint (e.g.,
    // `http://127.0.0.1:3100/otlp/v1/logs` for Loki's native OTLP receiver).
    // The general env var follows the OTel spec — it's a base URL, and the
    // signal-path suffix (/v1/logs for logs) is the caller's responsibility
    // when bypassing the SDK's own env-var resolution via `.with_endpoint()`.
    // The SDK only appends the signal path when IT reads OTEL_EXPORTER_OTLP_ENDPOINT
    // itself; programmatic `.with_endpoint()` is a full-URL override.
    // config.toml treats the value as a full URL (matches the LOGS_ENDPOINT form).
    // Log dir creation is fatal: the local JSONL file is the source of truth for
    // logs (OTLP is fire-and-forget shipping on top). Silently continuing with no
    // file logging would leave us blind to the next startup hang. Fail loud.
    let log_dir = floatty_server::config::data_dir().join("logs");
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        panic!(
            "Failed to create log directory {}: {}. Refusing to start without file logging.",
            log_dir.display(),
            e
        );
    }
    let otlp_endpoint = std::env::var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
        .ok()
        .or_else(|| {
            std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .map(|base| format!("{}/v1/logs", base.trim_end_matches('/')))
        })
        .or_else(|| config.otlp_endpoint.clone());
    let _otel = setup_logging(&log_dir, otlp_endpoint.as_deref());
    if _otel._logger.is_some() {
        // Never log the endpoint URL itself — it comes from user config or env
        // vars and may contain basic-auth userinfo, query tokens, or internal
        // hostnames. See .claude/rules/logging-discipline.md axis 1.
        tracing::info!(target: "floatty_startup", "otlp_log_export_enabled");
    }
    if _otel._tracer.is_some() {
        tracing::info!(target: "floatty_startup", "otlp_trace_export_enabled");
    }

    // Preflight: verify data dir matches build profile (FLO-317 "never again")
    {
        let data_root = floatty_server::config::data_dir();
        #[cfg(debug_assertions)]
        if data_root.ends_with(".floatty") && std::env::var("FLOATTY_DATA_DIR").is_err() {
            panic!("BUG: dev server resolved to release data dir. Check config::data_dir().");
        }
        #[cfg(not(debug_assertions))]
        if data_root.ends_with(".floatty-dev") && std::env::var("FLOATTY_DATA_DIR").is_err() {
            panic!("BUG: release server resolved to dev data dir. Check config::data_dir().");
        }
    }

    // Environment variables override config file (for Tauri spawn)
    let port: u16 = std::env::var("FLOATTY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(config.port);

    let api_key = std::env::var("FLOATTY_API_KEY")
        .ok()
        .unwrap_or_else(|| config.get_or_generate_api_key());

    // Check if server is disabled (only from config file, env spawned = always run)
    if std::env::var("FLOATTY_API_KEY").is_err() && !config.enabled {
        tracing::info!("Server disabled in config. Exiting.");
        return;
    }

    // Never log the full API key — this line is emitted on every startup and,
    // with OTLP export enabled, would ship the credential to any configured
    // remote collector. Log existence + length + source only.
    let api_key_source = if std::env::var("FLOATTY_API_KEY").is_ok() {
        "env"
    } else {
        "config"
    };
    tracing::info!(
        source = api_key_source,
        length = api_key.len(),
        "API key configured"
    );

    let startup_start = std::time::Instant::now();

    // Create the block store
    let store_start = std::time::Instant::now();
    let store = match YDocStore::new() {
        Ok(s) => Arc::new(s),
        Err(e) => {
            tracing::error!("Failed to create YDocStore: {}", e);
            std::process::exit(1);
        }
    };
    tracing::info!(
        target: "floatty_startup",
        elapsed_ms = store_start.elapsed().as_millis(),
        "phase=ydoc_store_ready"
    );

    // Initialize hook system (MetadataExtractionHook + PageNameIndexHook registered, cold start rehydration)
    let hooks_start = std::time::Instant::now();
    let hook_system = Arc::new(HookSystem::initialize(Arc::clone(&store)));
    tracing::info!(
        target: "floatty_startup",
        elapsed_ms = hooks_start.elapsed().as_millis(),
        "phase=hook_system_ready"
    );

    // Wire Y.Doc observation to hook system
    // This makes ALL Y.Doc mutations (including frontend sync) trigger hooks
    {
        let hook_system_clone = Arc::clone(&hook_system);
        store
            .set_change_callback(move |changes| {
                for change in changes {
                    if let Err(e) = hook_system_clone.emit_change(change) {
                        tracing::error!("Hook emission failed: {}", e);
                    }
                }
            })
            .expect("Failed to register change callback - hooks will not fire");
    }
    tracing::info!("Y.Doc change observation wired to hook system");

    // Create WebSocket broadcaster for real-time sync
    // FLO-152: Bumped from 64 to 256 to reduce likelihood of Lagged errors
    let broadcaster = Arc::new(WsBroadcaster::new(256));

    // FLO-391: Wire broadcast callback so hook metadata updates (which persist to
    // SQLite and consume seq numbers) also broadcast via WebSocket. Without this,
    // hook seqs create invisible gaps that trigger client-side gap-fill storms.
    {
        let broadcaster_clone = Arc::clone(&broadcaster);
        store.set_broadcast_callback(move |update, seq| {
            broadcaster_clone.broadcast(update, None, Some(seq));
        });
    }

    // Start heartbeat task - broadcasts latest seq every 30s if no updates sent
    // This closes the non-atomic persist-broadcast window gap
    start_heartbeat(Arc::clone(&broadcaster), Arc::clone(&store));

    // Initialize backup daemon if enabled (FLO-251)
    let backup_config = BackupConfig::load();
    let backup_daemon: Option<Arc<BackupDaemon>> = if backup_config.enabled {
        let backup_dir = backup::backup_dir();
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            tracing::error!("Failed to create backup directory: {}", e);
            None
        } else {
            let daemon = BackupDaemon::new(
                Arc::clone(&store),
                backup_config.clone(),
                backup_dir,
            );
            let daemon_arc = Arc::new(daemon);

            // Use the same Arc for both API and background task
            let _handle = Arc::clone(&daemon_arc).start();

            tracing::info!(
                "Backup daemon started (interval: {}h, retain: {}h/{}d/{}w)",
                backup_config.interval_hours,
                backup_config.retain_hourly,
                backup_config.retain_daily,
                backup_config.retain_weekly
            );

            Some(daemon_arc)
        }
    } else {
        tracing::info!("Backup daemon disabled");
        None
    };

    // Create outline manager for multi-outline support
    let data_dir = floatty_server::config::data_dir();
    let default_context = Arc::new(floatty_server::OutlineContext::new_default(
        Arc::clone(&store),
        Arc::clone(&hook_system),
        Arc::clone(&broadcaster),
        Some(data_dir.join("search_index")),
        backup_daemon.clone(),
    ));
    let outline_manager = Arc::new(OutlineManager::new_with_default(&data_dir, default_context, backup_config.clone()));
    tracing::info!("Outline manager initialized");

    // CORS layer - allow requests from Tauri webview (localhost origins)
    let cors = CorsLayer::new()
        .allow_origin(Any) // Tauri uses tauri://localhost or http://localhost
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);

    // Build router with CORS and optional auth middleware
    let api_routes = if config.auth_enabled {
        let auth_state = auth::ApiKeyAuth::new(api_key.clone());
        tracing::info!("API authentication enabled");
        api::create_router(Arc::clone(&store), Arc::clone(&broadcaster), Arc::clone(&hook_system), backup_daemon.clone(), Arc::clone(&outline_manager))
            .layer(middleware::from_fn_with_state(auth_state, auth::auth_middleware))
    } else {
        tracing::warn!("API authentication DISABLED (auth_enabled = false in config)");
        api::create_router(Arc::clone(&store), Arc::clone(&broadcaster), Arc::clone(&hook_system), backup_daemon.clone(), Arc::clone(&outline_manager))
    };

    // WebSocket route — supports ?outline={name} for per-outline subscriptions
    let ws_state = ws::WsState {
        default_broadcaster: Arc::clone(&broadcaster),
        outline_manager: Arc::clone(&outline_manager),
    };
    let ws_routes = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(ws_state);

    // Combine routes
    // 256MB — intentionally oversized. Single-user local app, no untrusted clients.
    // Y.Doc restore payload grows with outline size (currently ~22MB).
    // Previous incremental bumps (2→16→64) each caused an incident.
    // Set once, set high, never touch again.
    let app = Router::new()
        .merge(api_routes)
        .merge(ws_routes)
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024))
        .layer(cors);

    // Bind and serve (port from env overrides config)
    let addr: SocketAddr = format!("{}:{}", config.bind, port)
        .parse()
        .expect("Invalid bind address");

    tracing::info!(
        target: "floatty_startup",
        elapsed_ms = startup_start.elapsed().as_millis(),
        "phase=server_ready"
    );
    tracing::info!("floatty-server listening on http://{}", addr);
    tracing::info!("Health check: curl http://{}/api/v1/health", addr);
    if config.auth_enabled {
        // Printed to stderr via eprintln! for local discovery only — never via
        // the tracing subscriber, so it doesn't reach the JSONL file or the
        // OTLP collector. See .claude/rules/logging-discipline.md axis 2.
        #[cfg(debug_assertions)]
        eprintln!(
            "Authenticated: curl -H 'Authorization: Bearer {}' http://{}/api/v1/state",
            api_key, addr
        );
        tracing::info!("API authentication required (key redacted from logs)");
    } else {
        tracing::info!("No auth: curl http://{}/api/v1/blocks", addr);
    }

    // Bind with graceful failure: AddrInUse is the zombie-recovery failure
    // mode — another process is holding the port. Panic-via-unwrap here
    // dumps a backtrace to server.log that nobody reads; a clean exit with
    // a diagnostic message gives the parent app something actionable and
    // makes the failure obvious on next startup.
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            tracing::error!(
                addr = %addr,
                "Bind failed: port already in use. Another floatty-server \
                 (or other process) is holding this port. Kill the stale \
                 process and relaunch."
            );
            eprintln!(
                "[floatty-server] FATAL: {} already in use. \
                 Run: lsof -nP -iTCP:{} -sTCP:LISTEN",
                addr, port
            );
            std::process::exit(2);
        }
        Err(e) => {
            tracing::error!(addr = %addr, error = %e, "Bind failed");
            eprintln!("[floatty-server] FATAL: bind({}) failed: {}", addr, e);
            std::process::exit(1);
        }
    };
    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await {
        tracing::error!(error = %e, "axum::serve terminated with error");
        std::process::exit(1);
    }
}
