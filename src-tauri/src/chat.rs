use crate::accounts;
use crate::paths::home;
use crate::sessions::session_file;
use crate::util::{blocking, err, find_in_path, hidden};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use memchr::memmem;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const STRIPPED_ENV: [&str; 5] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CONFIG_DIR", "CLAUDE_AGENT_SDK_VERSION"];
const MAX_TOOL_TEXT: usize = 16_000;
const HISTORY_LINES: usize = 3_000;
const HISTORY_FIELDS: [&str; 6] = ["type", "subtype", "timestamp", "isMeta", "isCompactSummary", "isSidechain"];
const DROPPED_BLOCK_FIELDS: [&str; 2] = ["signature", "caller"];
const TAIL_CHUNK: usize = 1 << 20;
const BATCH_LINES: usize = 64;
const STREAM_ARGS: [&str; 9] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

const CHAT_IMAGES_PROMPT: &str = "<mavix_chat>
You are running inside the chat panel of the Mavix IDE, and the user reads your work there. Mavix shows local pictures right inside the chat.
To show the user a screenshot or any picture, save it as a PNG, JPEG, WebP or GIF file and write it as a Markdown image with its absolute path, using forward slashes: ![Скріншот-1](C:/Users/name/shots/shot-1.png). If the path has spaces, wrap it in angle brackets: ![Скріншот-1](<C:/My Folder/shot-1.png>).
This works in your normal messages and inside AskUserQuestion: in the question text, in an option's description, and best of all in each option's preview field. In the question window the user then sees every option as a card with its screenshot and picks one by clicking it.
Whenever you ask the user to compare or choose between looks (Скріншот-1, Скріншот-2 and so on), take the real screenshots first and embed each one in its option this way, one screenshot per option. Never ask about a screenshot the user cannot see, and never describe a screenshot in words instead of showing it.
</mavix_chat>";

static GENERATION: AtomicU64 = AtomicU64::new(1);

struct Process {
    stdin: ChildStdin,
    pid: u32,
    generation: u64,
}

#[derive(Default)]
pub struct Chats(Mutex<HashMap<String, Process>>);

impl Chats {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, process) in map.drain() {
                kill_tree(process.pid);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStart {
    id: String,
    cwd: String,
    account_id: Option<String>,
    session_id: Option<String>,
    resume: bool,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
}

#[derive(Serialize, Clone)]
struct ChatLines {
    id: String,
    lines: Vec<String>,
}

#[derive(Serialize, Clone)]
struct ChatText {
    id: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct ChatExit {
    id: String,
    code: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistory {
    lines: Vec<String>,
    title: Option<String>,
}

fn kill_tree(pid: u32) {
    let _ = hidden("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub(crate) fn claude_program() -> Option<PathBuf> {
    find_in_path(&["claude.exe"])
        .or_else(|| {
            let local = home().join(".local").join("bin").join("claude.exe");
            local.is_file().then_some(local)
        })
        .or_else(|| find_in_path(&["claude.cmd"]))
}

fn filled(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(String::from)
}

fn clip_in_place(text: &mut String) {
    if text.len() <= MAX_TOOL_TEXT {
        return;
    }
    let mut cut = MAX_TOOL_TEXT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str("\n…");
}

fn strip_image(part: &mut Value) {
    if part.get("type").and_then(|t| t.as_str()) == Some("image") {
        if let Some(source) = part.get_mut("source").and_then(|s| s.as_object_mut()) {
            source.remove("data");
        }
    }
}

fn prune_user(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("tool_use_result");
        object.remove("toolUseResult");
    }
    let Some(items) = value.pointer_mut("/message/content").and_then(|c| c.as_array_mut()) else { return };
    for item in items {
        strip_image(item);
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        match item.get_mut("content") {
            Some(Value::String(text)) => clip_in_place(text),
            Some(Value::Array(parts)) => {
                for part in parts {
                    strip_image(part);
                    if let Some(Value::String(text)) = part.get_mut("text") {
                        clip_in_place(text);
                    }
                }
            }
            _ => {}
        }
    }
}

fn prepare_line(line: &str) -> String {
    if !line.starts_with("{\"type\":\"user\"") {
        return line.to_string();
    }
    match serde_json::from_str::<Value>(line) {
        Ok(mut value) => {
            prune_user(&mut value);
            serde_json::to_string(&value).unwrap_or_else(|_| line.to_string())
        }
        Err(_) => line.to_string(),
    }
}

fn is_current(app: &AppHandle, id: &str, generation: u64) -> bool {
    app.state::<Chats>().0.lock().map(|map| map.get(id).is_some_and(|p| p.generation == generation)).unwrap_or(false)
}

#[tauri::command]
pub fn chat_start(app: AppHandle, chats: State<Chats>, req: ChatStart) -> Result<u32, String> {
    let program = claude_program().ok_or("Не знайдено claude. Встанови Claude Code і перезапусти Mavix")?;
    let mut args: Vec<String> = STREAM_ARGS.iter().map(|s| s.to_string()).collect();
    if let Some(session) = filled(&req.session_id) {
        args.push(if req.resume { "--resume".into() } else { "--session-id".into() });
        args.push(session);
    }
    if let Some(model) = filled(&req.model) {
        args.push("--model".into());
        args.push(model);
    }
    if let Some(effort) = filled(&req.effort) {
        args.push("--effort".into());
        args.push(effort);
    }
    if let Some(mode) = filled(&req.permission_mode) {
        args.push("--permission-mode".into());
        args.push(if mode == "default" { "manual".into() } else { mode });
    }
    let is_script = program.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    if !is_script {
        let appended = match crate::rules::rules_prompt() {
            Some(rules) => format!("{rules}\n\n{CHAT_IMAGES_PROMPT}"),
            None => CHAT_IMAGES_PROMPT.to_string(),
        };
        args.push("--append-system-prompt".into());
        args.push(appended);
    }
    let mut command = if is_script {
        let mut shell = hidden("cmd.exe");
        shell.arg("/C").arg(&program);
        shell
    } else {
        hidden(&program.to_string_lossy())
    };
    command.args(&args);
    let cwd = Path::new(&req.cwd);
    command.current_dir(if cwd.is_dir() { cwd.to_path_buf() } else { home() });
    for key in STRIPPED_ENV {
        command.env_remove(key);
    }
    command.env("TERM_PROGRAM", "Mavix");
    if let Some(dir) = req.account_id.as_deref().and_then(accounts::extra_config_dir) {
        command.env("CLAUDE_CONFIG_DIR", dir);
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(err)?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("Не вдалося відкрити вхід claude")?;
    let stdout = child.stdout.take().ok_or("Не вдалося відкрити вихід claude")?;
    let stderr = child.stderr.take().ok_or("Не вдалося відкрити помилки claude")?;
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);

    let replaced = chats.0.lock().map_err(err)?.insert(req.id.clone(), Process { stdin, pid, generation });
    if let Some(old) = replaced {
        std::thread::spawn(move || kill_tree(old.pid));
    }

    let reader_app = app.clone();
    let reader_id = req.id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::with_capacity(256 * 1024, stdout);
        let mut raw = Vec::new();
        let mut batch: Vec<String> = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&raw);
                    let line = text.trim();
                    if !line.is_empty() {
                        batch.push(prepare_line(line));
                    }
                    if batch.len() >= BATCH_LINES || (reader.buffer().is_empty() && !batch.is_empty()) {
                        let lines = std::mem::take(&mut batch);
                        if is_current(&reader_app, &reader_id, generation) {
                            let _ = reader_app.emit("chat-lines", ChatLines { id: reader_id.clone(), lines });
                        }
                    }
                }
            }
        }
        if !batch.is_empty() && is_current(&reader_app, &reader_id, generation) {
            let _ = reader_app.emit("chat-lines", ChatLines { id: reader_id.clone(), lines: batch });
        }
    });

    let error_app = app.clone();
    let error_id = req.id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let text = line.trim().to_string();
            if !text.is_empty() && is_current(&error_app, &error_id, generation) {
                let _ = error_app.emit("chat-stderr", ChatText { id: error_id.clone(), text });
            }
        }
    });

    let waiter_app = app.clone();
    let waiter_id = req.id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(1);
        std::thread::sleep(Duration::from_millis(200));
        let removed = waiter_app.state::<Chats>().0.lock().ok().and_then(|mut map| {
            let current = map.get(&waiter_id).is_some_and(|p| p.generation == generation);
            if current { map.remove(&waiter_id) } else { None }
        });
        if removed.is_some() {
            let _ = waiter_app.emit("chat-exit", ChatExit { id: waiter_id, code });
        }
    });

    Ok(pid)
}

#[tauri::command]
pub fn chat_send(chats: State<Chats>, id: String, line: String) -> Result<(), String> {
    let mut map = chats.0.lock().map_err(err)?;
    let process = map.get_mut(&id).ok_or("Claude не запущено")?;
    process.stdin.write_all(line.trim_end().as_bytes()).map_err(err)?;
    process.stdin.write_all(b"\n").map_err(err)?;
    process.stdin.flush().map_err(err)
}

#[tauri::command]
pub fn chat_stop(chats: State<Chats>, id: String) -> Result<(), String> {
    let removed = chats.0.lock().map_err(err)?.remove(&id);
    if let Some(process) = removed {
        let pid = process.pid;
        drop(process);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            kill_tree(pid);
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn chat_history(account_id: String, session_id: String) -> Result<ChatHistory, String> {
    blocking(move || {
        let Some(path) = session_file(&account_id, &session_id) else {
            return Ok(ChatHistory { lines: vec![], title: None });
        };
        let scan = read_tail(&path)?;
        Ok(ChatHistory { lines: scan.lines, title: scan.custom_title.or(scan.ai_title) })
    })
    .await
}

#[derive(Default)]
struct HistoryScan {
    lines: Vec<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
}

fn compact_history(mut value: Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in HISTORY_FIELDS {
        if let Some(field) = value.get(key) {
            out.insert(key.into(), field.clone());
        }
    }
    if let Some(content) = value.pointer_mut("/message/content").map(Value::take) {
        let mut content = content;
        if let Some(blocks) = content.as_array_mut() {
            for block in blocks.iter_mut().filter_map(|b| b.as_object_mut()) {
                for key in DROPPED_BLOCK_FIELDS {
                    block.remove(key);
                }
            }
        }
        let mut message = serde_json::Map::new();
        message.insert("content".into(), content);
        out.insert("message".into(), Value::Object(message));
    }
    Value::Object(out)
}

fn trim_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(start, |i| i + 1);
    &bytes[start..end]
}

fn take_history_line(raw: &[u8], scan: &mut HistoryScan, finders: &[memmem::Finder; 4]) {
    if raw.first() != Some(&b'{') || !finders.iter().any(|f| f.find(raw).is_some()) {
        return;
    }
    let Ok(mut value) = serde_json::from_slice::<Value>(raw) else { return };
    let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
    match kind.as_str() {
        "custom-title" if scan.custom_title.is_none() => scan.custom_title = value.get("customTitle").and_then(|t| t.as_str()).map(String::from),
        "ai-title" if scan.ai_title.is_none() => scan.ai_title = value.get("aiTitle").and_then(|t| t.as_str()).map(String::from),
        "user" | "assistant" => {
            if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
                return;
            }
            if kind == "user" {
                prune_user(&mut value);
            }
            if let Ok(text) = serde_json::to_string(&compact_history(value)) {
                scan.lines.push(text);
            }
        }
        "system" if value.get("subtype").and_then(|s| s.as_str()) == Some("compact_boundary") => {
            if let Ok(text) = serde_json::to_string(&compact_history(value)) {
                scan.lines.push(text);
            }
        }
        _ => {}
    }
}

fn read_tail(path: &Path) -> Result<HistoryScan, String> {
    let mut file = fs::File::open(path).map_err(err)?;
    let mut position = file.metadata().map_err(err)?.len();
    let finders = [
        memmem::Finder::new(b"\"type\":\"user\""),
        memmem::Finder::new(b"\"type\":\"assistant\""),
        memmem::Finder::new(b"compact_boundary"),
        memmem::Finder::new(b"-title\""),
    ];
    let mut scan = HistoryScan::default();
    let mut carry: Vec<u8> = Vec::new();
    while position > 0 && scan.lines.len() < HISTORY_LINES {
        let size = TAIL_CHUNK.min(position as usize);
        position -= size as u64;
        let mut chunk = vec![0u8; size];
        file.seek(SeekFrom::Start(position)).map_err(err)?;
        file.read_exact(&mut chunk).map_err(err)?;
        chunk.extend_from_slice(&carry);
        carry.clear();
        let mut end = chunk.len();
        while let Some(newline) = memchr::memrchr(b'\n', &chunk[..end]) {
            let line = trim_bytes(&chunk[newline + 1..end]);
            if !line.is_empty() {
                take_history_line(line, &mut scan, &finders);
                if scan.lines.len() >= HISTORY_LINES {
                    break;
                }
            }
            end = newline;
        }
        if scan.lines.len() < HISTORY_LINES {
            carry = chunk[..end].to_vec();
        }
    }
    if position == 0 && scan.lines.len() < HISTORY_LINES {
        let line = trim_bytes(&carry);
        if !line.is_empty() {
            take_history_line(line, &mut scan, &finders);
        }
    }
    scan.lines.reverse();
    Ok(scan)
}
