use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use futures_util::StreamExt;
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState},
};
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::io::stdout;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;

// --- Data ---

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FloatBlock {
    id: String,
    content: String,
    #[serde(default)]
    child_ids: Vec<String>,
    parent_id: Option<String>,
    #[serde(default)]
    collapsed: bool,
}

#[derive(Debug, Deserialize)]
struct BlocksResponse {
    blocks: Vec<FloatBlock>,
    root_ids: Vec<String>,
}

// --- Tree State ---

struct TreeState {
    blocks: HashMap<String, FloatBlock>,
    root_ids: Vec<String>,
    local_collapsed: HashMap<String, bool>,
}

impl TreeState {
    fn from_response(resp: BlocksResponse) -> Self {
        let blocks: HashMap<String, FloatBlock> = resp
            .blocks
            .into_iter()
            .map(|b| (b.id.clone(), b))
            .collect();
        Self {
            blocks,
            root_ids: resp.root_ids,
            local_collapsed: HashMap::new(),
        }
    }

    fn update_from_response(&mut self, resp: BlocksResponse) {
        let new_blocks: HashMap<String, FloatBlock> = resp
            .blocks
            .into_iter()
            .map(|b| (b.id.clone(), b))
            .collect();
        self.blocks = new_blocks;
        self.root_ids = resp.root_ids;
        // Keep local_collapsed — user's local toggle state survives refresh
    }

    fn is_collapsed(&self, id: &str) -> bool {
        if let Some(&local) = self.local_collapsed.get(id) {
            return local;
        }
        self.blocks.get(id).is_some_and(|b| b.collapsed)
    }

    fn toggle_collapsed(&mut self, id: &str) {
        let current = self.is_collapsed(id);
        self.local_collapsed.insert(id.to_string(), !current);
    }

    fn has_children(&self, id: &str) -> bool {
        self.blocks
            .get(id)
            .is_some_and(|b| !b.child_ids.is_empty())
    }

    fn visible_rows(&self) -> Vec<(String, usize)> {
        let mut rows = Vec::new();
        for root_id in &self.root_ids {
            self.collect_visible(root_id, 0, &mut rows);
        }
        rows
    }

    fn collect_visible(&self, id: &str, depth: usize, out: &mut Vec<(String, usize)>) {
        out.push((id.to_string(), depth));
        if self.is_collapsed(id) {
            return;
        }
        if let Some(block) = self.blocks.get(id) {
            for child_id in &block.child_ids {
                self.collect_visible(child_id, depth + 1, out);
            }
        }
    }

    fn descendant_count(&self, id: &str) -> usize {
        let Some(block) = self.blocks.get(id) else {
            return 0;
        };
        let mut count = 0;
        for child_id in &block.child_ids {
            count += 1 + self.descendant_count(child_id);
        }
        count
    }
}

// --- App ---

struct App {
    tree: TreeState,
    cursor: usize,
    scroll_offset: usize,
    viewport_height: usize,
    ws_connected: bool,
    update_count: u64,
    following: bool,
    follow_block_id: Option<String>,
    focus_log: VecDeque<String>,
}

impl App {
    fn new(tree: TreeState) -> Self {
        Self {
            tree,
            cursor: 0,
            scroll_offset: 0,
            viewport_height: 20,
            ws_connected: false,
            update_count: 0,
            following: true,
            follow_block_id: None,
            focus_log: VecDeque::new(),
        }
    }

    fn visible_rows(&self) -> Vec<(String, usize)> {
        self.tree.visible_rows()
    }

    fn move_up(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
        self.ensure_visible();
    }

    fn move_down(&mut self) {
        let rows = self.visible_rows();
        if self.cursor + 1 < rows.len() {
            self.cursor += 1;
        }
        self.ensure_visible();
    }

    fn toggle(&mut self) {
        let rows = self.visible_rows();
        if let Some((id, _)) = rows.get(self.cursor) {
            if self.tree.has_children(id) {
                self.tree.toggle_collapsed(id);
            }
        }
    }

    fn ensure_visible(&mut self) {
        if self.cursor < self.scroll_offset {
            self.scroll_offset = self.cursor;
        }
        if self.cursor >= self.scroll_offset + self.viewport_height {
            self.scroll_offset = self.cursor - self.viewport_height + 1;
        }
    }

    fn center_cursor(&mut self) {
        self.scroll_offset = self.cursor.saturating_sub(self.viewport_height / 3);
    }

    fn clamp_cursor(&mut self) {
        let rows = self.visible_rows();
        if !rows.is_empty() && self.cursor >= rows.len() {
            self.cursor = rows.len() - 1;
        }
        self.ensure_visible();
    }

    fn navigate_to_block(&mut self, block_id: &str) {
        self.follow_block_id = Some(block_id.to_string());

        // Expand ancestors so the block is visible
        self.expand_ancestors(block_id);

        let rows = self.visible_rows();
        if let Some(pos) = rows.iter().position(|(id, _)| id == block_id) {
            self.cursor = pos;
            self.center_cursor();
        }
    }

    fn expand_ancestors(&mut self, block_id: &str) {
        // Walk up from block_id, uncollapsing each ancestor
        let mut current = block_id.to_string();
        let mut ancestors = Vec::new();
        while let Some(block) = self.tree.blocks.get(&current) {
            if let Some(ref pid) = block.parent_id {
                ancestors.push(pid.clone());
                current = pid.clone();
            } else {
                break;
            }
        }
        for ancestor_id in &ancestors {
            if self.tree.is_collapsed(ancestor_id) {
                self.tree.local_collapsed.insert(ancestor_id.clone(), false);
            }
        }
    }
}

// --- Fetch ---

async fn fetch_blocks(port: u16, api_key: &str) -> Result<BlocksResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://127.0.0.1:{}/api/v1/blocks", port))
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await?
        .json::<BlocksResponse>()
        .await?;
    Ok(resp)
}

// --- WebSocket listener ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsMessage {
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    presence: Option<WsPresence>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsPresence {
    block_id: String,
}

fn spawn_ws_listener(
    port: u16,
    dirty: Arc<AtomicBool>,
    ws_alive: Arc<AtomicBool>,
    update_count: Arc<AtomicU64>,
    presence_tx: mpsc::UnboundedSender<String>,
) {
    tokio::spawn(async move {
        let url = format!("ws://127.0.0.1:{}/ws", port);
        match connect_async(&url).await {
            Ok((ws_stream, _)) => {
                ws_alive.store(true, Ordering::Relaxed);
                let (_write, mut read) = ws_stream.split();
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(tungstenite_msg) => {
                            let text = match &tungstenite_msg {
                                tokio_tungstenite::tungstenite::Message::Text(t) => Some(t.as_str()),
                                _ => None,
                            };
                            if let Some(text) = text {
                                if let Ok(parsed) = serde_json::from_str::<WsMessage>(text) {
                                    if let Some(p) = parsed.presence {
                                        let _ = presence_tx.send(p.block_id);
                                        continue; // presence-only, don't trigger data refresh
                                    }
                                    if parsed.data.is_some() {
                                        dirty.store(true, Ordering::Relaxed);
                                        update_count.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            ws_alive.store(false, Ordering::Relaxed);
                            break;
                        }
                    }
                }
                ws_alive.store(false, Ordering::Relaxed);
            }
            Err(_) => {
                ws_alive.store(false, Ordering::Relaxed);
            }
        }
    });
}

// --- Rendering ---

fn render_tree(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let ws_indicator = if app.ws_connected { " [LIVE]" } else { " [offline]" };
    let title = format!(" floatty-tui (read-only){} ", ws_indicator);

    let outer = Block::default()
        .title(title)
        .title_alignment(Alignment::Center)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if app.ws_connected {
            Color::Green
        } else {
            Color::DarkGray
        }));

    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    // Layout: tree (top) | preview (bottom 6 lines) | status (1 line)
    let preview_height: u16 = 6;
    let status_height: u16 = 1;
    let bottom_total = preview_height + status_height;

    let tree_area = Rect {
        x: inner.x,
        y: inner.y,
        width: inner.width.saturating_sub(1),
        height: inner.height.saturating_sub(bottom_total),
    };
    let scrollbar_area = Rect {
        x: inner.x + inner.width.saturating_sub(1),
        y: inner.y,
        width: 1,
        height: inner.height.saturating_sub(bottom_total),
    };
    let preview_area = Rect {
        x: inner.x,
        y: inner.y + inner.height.saturating_sub(bottom_total),
        width: inner.width,
        height: preview_height,
    };
    let status_area = Rect {
        x: inner.x,
        y: inner.y + inner.height.saturating_sub(status_height),
        width: inner.width,
        height: status_height,
    };

    let rows = app.visible_rows();
    let total_rows = rows.len();

    let mut lines: Vec<Line> = Vec::new();
    let end = (app.scroll_offset + tree_area.height as usize).min(total_rows);

    for i in app.scroll_offset..end {
        let (ref id, depth) = rows[i];
        let block = app.tree.blocks.get(id);
        let content = block.map(|b| b.content.as_str()).unwrap_or("???");
        let has_children = app.tree.has_children(id);
        let is_collapsed = app.tree.is_collapsed(id);
        let is_cursor = i == app.cursor;

        let indent = "  ".repeat(depth);

        let bullet = if has_children {
            if is_collapsed { "▸ " } else { "▾ " }
        } else {
            "• "
        };

        let suffix = if has_children && is_collapsed {
            let count = app.tree.descendant_count(id);
            format!(" ({})", count)
        } else {
            String::new()
        };

        let max_content = (tree_area.width as usize)
            .saturating_sub(indent.len() + bullet.len() + suffix.len());
        let display_content: String = if content.chars().count() > max_content {
            let truncated: String = content.chars().take(max_content.saturating_sub(1)).collect();
            format!("{}…", truncated)
        } else {
            content.to_string()
        };

        let line_str = format!("{}{}{}{}", indent, bullet, display_content, suffix);

        let style = if is_cursor {
            Style::default().bg(Color::DarkGray).fg(Color::White)
        } else if has_children && is_collapsed {
            Style::default().fg(Color::Yellow)
        } else if depth == 0 {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };

        lines.push(Line::styled(line_str, style));
    }

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, tree_area);

    let mut scrollbar_state =
        ScrollbarState::new(total_rows.saturating_sub(tree_area.height as usize))
            .position(app.scroll_offset);
    frame.render_stateful_widget(
        Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .begin_symbol(None)
            .end_symbol(None),
        scrollbar_area,
        &mut scrollbar_state,
    );

    // Preview pane: full content of focused block, wrapped
    let cursor_content = rows
        .get(app.cursor)
        .and_then(|(id, _)| app.tree.blocks.get(id))
        .map(|b| b.content.as_str())
        .unwrap_or("");
    let preview_block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(" preview ")
        .title_style(Style::default().fg(Color::DarkGray));
    let preview_widget = Paragraph::new(cursor_content)
        .wrap(ratatui::widgets::Wrap { trim: false })
        .style(Style::default().fg(Color::White))
        .block(preview_block);
    frame.render_widget(preview_widget, preview_area);

    let cursor_id = rows
        .get(app.cursor)
        .map(|(id, _)| id.get(..8).unwrap_or(id.as_str()))
        .unwrap_or("---");
    let follow_indicator = if app.following { " │ FOLLOW" } else { "" };
    let status = format!(
        " {} blocks │ {} visible │ row {}/{} │ {} │ updates: {}{}",
        app.tree.blocks.len(),
        total_rows,
        app.cursor + 1,
        total_rows,
        cursor_id,
        app.update_count,
        follow_indicator,
    );
    let status_widget =
        Paragraph::new(status).style(Style::default().fg(Color::DarkGray));
    frame.render_widget(status_widget, status_area);
}

// --- Main ---

#[tokio::main]
async fn main() -> Result<()> {
    let config_dir = std::env::var("FLOATTY_DATA_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{}/.floatty", home)
    });
    let (port, api_key) = read_config(&config_dir)?;

    eprintln!("Fetching blocks from port {}...", port);
    let resp = fetch_blocks(port, &api_key).await?;
    eprintln!(
        "Got {} blocks, {} roots",
        resp.blocks.len(),
        resp.root_ids.len()
    );

    let tree = TreeState::from_response(resp);
    let mut app = App::new(tree);

    // WebSocket live updates
    let dirty = Arc::new(AtomicBool::new(false));
    let ws_alive = Arc::new(AtomicBool::new(false));
    let update_counter = Arc::new(AtomicU64::new(0));
    let (presence_tx, mut presence_rx) = mpsc::unbounded_channel::<String>();
    spawn_ws_listener(port, dirty.clone(), ws_alive.clone(), update_counter.clone(), presence_tx);

    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    // Debounce: don't re-fetch more than once per 500ms
    let mut last_refresh = std::time::Instant::now();

    loop {
        // Check for dirty flag from WS
        app.ws_connected = ws_alive.load(Ordering::Relaxed);
        app.update_count = update_counter.load(Ordering::Relaxed);

        if dirty.load(Ordering::Relaxed) && last_refresh.elapsed() > std::time::Duration::from_millis(500) {
            dirty.store(false, Ordering::Relaxed);
            if let Ok(resp) = fetch_blocks(port, &api_key).await {
                app.tree.update_from_response(resp);
                app.clamp_cursor();
            }
            last_refresh = std::time::Instant::now();
        }

        // Drain presence messages — navigate to the latest one + write to /tmp
        {
            let mut latest_presence: Option<String> = None;
            while let Ok(block_id) = presence_rx.try_recv() {
                latest_presence = Some(block_id);
            }
            if let Some(ref block_id) = latest_presence {
                if app.following {
                    app.navigate_to_block(block_id);
                }
                // Write rolling focus log to /tmp
                if let Some(block) = app.tree.blocks.get(block_id) {
                    let short_id = block_id.get(..8).unwrap_or(block_id.as_str());
                    let entry = format!("[{}] {}\n{}\n---\n", short_id, block.content, block_id);
                    app.focus_log.push_back(entry);
                    while app.focus_log.len() > 5 {
                        app.focus_log.pop_front();
                    }
                    let log_content: String = app.focus_log.iter().cloned().collect();
                    let _ = std::fs::write("/tmp/floatty-focus.txt", log_content);
                }
            }
        }

        let size = terminal.size()?;
        app.viewport_height = (size.height as usize).saturating_sub(4);

        terminal.draw(|frame| render_tree(frame, &app))?;

        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => break,
                    KeyCode::Char('f') => {
                        app.following = !app.following;
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        app.following = false;
                        app.move_up();
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        app.following = false;
                        app.move_down();
                    }
                    KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') => app.toggle(),
                    KeyCode::Left | KeyCode::Char('h') => {
                        let rows = app.visible_rows();
                        if let Some((id, _)) = rows.get(app.cursor) {
                            if app.tree.has_children(id) && !app.tree.is_collapsed(id) {
                                app.tree.toggle_collapsed(id);
                            } else if let Some(block) = app.tree.blocks.get(id) {
                                if let Some(ref parent_id) = block.parent_id {
                                    let parent_id = parent_id.clone();
                                    let rows = app.visible_rows();
                                    if let Some(pos) =
                                        rows.iter().position(|(rid, _)| *rid == parent_id)
                                    {
                                        app.cursor = pos;
                                        app.ensure_visible();
                                    }
                                }
                            }
                        }
                    }
                    KeyCode::Home | KeyCode::Char('g') => {
                        app.cursor = 0;
                        app.ensure_visible();
                    }
                    KeyCode::End | KeyCode::Char('G') => {
                        let rows = app.visible_rows();
                        if !rows.is_empty() {
                            app.cursor = rows.len() - 1;
                        }
                        app.ensure_visible();
                    }
                    KeyCode::PageUp => {
                        app.cursor = app.cursor.saturating_sub(app.viewport_height);
                        app.ensure_visible();
                    }
                    KeyCode::PageDown => {
                        let rows = app.visible_rows();
                        app.cursor =
                            (app.cursor + app.viewport_height).min(rows.len().saturating_sub(1));
                        app.ensure_visible();
                    }
                    // Manual refresh
                    KeyCode::Char('r') => {
                        if let Ok(resp) = fetch_blocks(port, &api_key).await {
                            app.tree.update_from_response(resp);
                            app.clamp_cursor();
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}

fn read_config(data_dir: &str) -> Result<(u16, String)> {
    let config_path = format!("{}/config.toml", data_dir);
    let content = std::fs::read_to_string(&config_path)?;

    let mut port: u16 = 8765;
    let mut api_key = String::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("server_port") {
            if let Some(val) = line.split('=').nth(1) {
                port = val.trim().parse().unwrap_or(8765);
            }
        } else if line.starts_with("api_key") {
            if let Some(val) = line.split('"').nth(1) {
                api_key = val.to_string();
            }
        }
    }

    if api_key.is_empty() {
        anyhow::bail!("No api_key found in {}", config_path);
    }

    Ok((port, api_key))
}
