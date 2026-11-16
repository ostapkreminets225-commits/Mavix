use crate::accounts::{self, AccountRecord};
use crate::util::{blocking, copy_dir, err, mtime_ms, path_string};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const HEAD_BYTES: u64 = 192 * 1024;
const TAIL_BYTES: u64 = 96 * 1024;
const MAX_MESSAGES: usize = 600;
const MAX_TEXT: usize = 24_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    id: String,
    account_id: String,
    title: String,
    first_prompt: String,
    cwd: String,
    git_branch: String,
    modified: u64,
    size: u64,
    file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    name: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    role: String,
    text: String,
    tools: Vec<ToolUse>,
    time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    messages: Vec<Message>,
    total: usize,
    cwd: String,
}

#[derive(Default)]
pub struct SessionCache(Mutex<HashMap<String, (u64, u64, SessionInfo)>>);

fn read_range(file: &mut fs::File, start: u64, length: u64) -> String {
    let mut buffer = Vec::with_capacity(length as usize);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let _ = file.take(length).read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).into_owned()
}

fn prompt_text(value: &Value) -> Option<String> {
    if value.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let content = value.pointer("/message/content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with("Caveat:") || trimmed.starts_with("[Request interrupted") {
        return None;
    }
    Some(trimmed.to_string())
}

fn clip(text: &str, limit: usize) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= limit {
        single
    } else {
        single.chars().take(limit).collect::<String>() + "…"
    }
}

fn scan_file(path: &Path, account_id: &str, size: u64, modified: u64) -> Option<SessionInfo> {
    let mut file = fs::File::open(path).ok()?;
    let head = read_range(&mut file, 0, HEAD_BYTES.min(size));
    let tail = if size > HEAD_BYTES { read_range(&mut file, size.saturating_sub(TAIL_BYTES), TAIL_BYTES) } else { String::new() };
    let mut cwd = String::new();
    let mut branch = String::new();
    let mut first_prompt = String::new();
    let mut custom_title = String::new();
    let mut ai_title = String::new();
    let mut summary = String::new();
    let mut last_prompt = String::new();
    let mut inspect = |line: &str| {
        if line.len() < 2 || !line.starts_with('{') {
            return;
        }
        let interesting = line.contains("\"cwd\"") || line.contains("-title\"") || line.contains("\"summary\"") || line.contains("\"last-prompt\"");
        if !interesting {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else { return };
        if cwd.is_empty() {
            if let Some(c) = value.get("cwd").and_then(|v| v.as_str()) {
                cwd = c.to_string();
            }
        }
        if branch.is_empty() {
            if let Some(b) = value.get("gitBranch").and_then(|v| v.as_str()) {
                branch = b.to_string();
            }
        }
        match value.get("type").and_then(|v| v.as_str()) {
            Some("user") if first_prompt.is_empty() => {
                if let Some(text) = prompt_text(&value) {
                    first_prompt = clip(&text, 240);
                }
            }
            Some("custom-title") => {
                if let Some(t) = value.get("customTitle").and_then(|v| v.as_str()) {
                    custom_title = t.to_string();
                }
            }
            Some("ai-title") => {
                if let Some(t) = value.get("aiTitle").and_then(|v| v.as_str()) {
                    ai_title = t.to_string();
                }
            }
            Some("summary") => {
                if let Some(t) = value.get("summary").and_then(|v| v.as_str()) {
                    summary = t.to_string();
                }
            }
            Some("last-prompt") => {
                if let Some(t) = value.get("lastPrompt").and_then(|v| v.as_str()) {
                    last_prompt = t.to_string();
                }
            }
            _ => {}
        }
    };
    let head_lines: Vec<&str> = head.split('\n').collect();
    let head_complete = if size > HEAD_BYTES { head_lines.len().saturating_sub(1) } else { head_lines.len() };
    for line in &head_lines[..head_complete] {
        inspect(line.trim_end());
    }
    for line in tail.split('\n').skip(1) {
        inspect(line.trim_end());
    }
    if cwd.is_empty() && first_prompt.is_empty() && ai_title.is_empty() && custom_title.is_empty() {
        return None;
    }
    if first_prompt.is_empty() {
        first_prompt = clip(&last_prompt, 240);
    }
    let title = [custom_title, ai_title, summary, clip(&first_prompt, 90)]
        .into_iter()
        .find(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Без назви".into());
    Some(SessionInfo {
        id: path.file_stem()?.to_string_lossy().to_string(),
        account_id: account_id.to_string(),
        title,
        first_prompt,
        cwd,
        git_branch: branch,
        modified,
        size,
        file: path_string(path),
    })
}

fn session_files(record: &AccountRecord) -> Vec<(PathBuf, u64, u64)> {
    let projects = accounts::config_dir(record).join("projects");
    let Ok(read) = fs::read_dir(projects) else { return vec![] };
    let mut files = Vec::new();
    for project in read.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
        let Ok(inner) = fs::read_dir(project.path()) else { continue };
        for entry in inner.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() > 0 {
                    files.push((path, meta.len(), mtime_ms(&meta)));
                }
            }
        }
    }
    files
}

#[tauri::command]
pub async fn sessions_list(app: AppHandle, account_id: Option<String>) -> Result<Vec<SessionInfo>, String> {
    blocking(move || {
        let cache = app.state::<SessionCache>();
        let records: Vec<AccountRecord> = accounts::all_records()
            .into_iter()
            .filter(|r| account_id.as_ref().is_none_or(|id| &r.id == id))
            .collect();
        let mut result = Vec::new();
        for record in records {
            for (path, size, modified) in session_files(&record) {
                let key = format!("{}|{}", record.id, path.display());
                let cached = cache.0.lock().ok().and_then(|map| map.get(&key).cloned());
                if let Some((cached_size, cached_modified, info)) = cached {
                    if cached_size == size && cached_modified == modified {
                        result.push(info);
                        continue;
                    }
                }
                if let Some(info) = scan_file(&path, &record.id, size, modified) {
                    if let Ok(mut map) = cache.0.lock() {
                        map.insert(key, (size, modified, info.clone()));
                    }
                    result.push(info);
                }
            }
        }
        result.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(result)
    })
    .await
}

fn tool_detail(input: &Value) -> String {
    for key in ["file_path", "command", "pattern", "path", "url", "query", "description", "prompt", "skill", "notebook_path"] {
        if let Some(text) = input.get(key).and_then(|v| v.as_str()) {
            return clip(text, 140);
        }
    }
    String::new()
}

#[tauri::command]
pub async fn session_read(file: String) -> Result<Transcript, String> {
    blocking(move || {
        let path = PathBuf::from(&file);
        let allowed = accounts::all_records().iter().any(|r| path.starts_with(accounts::config_dir(r).join("projects")));
        if !allowed {
            return Err("Ця сесія не належить жодному акаунту".into());
        }
        let reader = BufReader::new(fs::File::open(&path).map_err(err)?);
        let mut messages: Vec<Message> = Vec::new();
        let mut cwd = String::new();
        for line in reader.lines().map_while(Result::ok) {
            let is_user = line.contains("\"type\":\"user\"");
            let is_assistant = line.contains("\"type\":\"assistant\"");
            if !is_user && !is_assistant {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            if cwd.is_empty() {
                if let Some(c) = value.get("cwd").and_then(|v| v.as_str()) {
                    cwd = c.to_string();
                }
            }
            let time = value.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match value.get("type").and_then(|v| v.as_str()) {
                Some("user") => {
                    if let Some(text) = prompt_text(&value) {
                        messages.push(Message { role: "user".into(), text: text.chars().take(MAX_TEXT).collect(), tools: vec![], time });
                    } else if let Some(Value::String(raw)) = value.pointer("/message/content") {
                        if let Some(name) = raw.split("<command-name>").nth(1).and_then(|r| r.split("</command-name>").next()) {
                            messages.push(Message { role: "command".into(), text: name.trim().to_string(), tools: vec![], time });
                        }
                    }
                }
                Some("assistant") => {
                    let Some(items) = value.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
                    let mut text = String::new();
                    let mut tools = Vec::new();
                    for item in items {
                        match item.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                                    if !text.is_empty() {
                                        text.push_str("\n\n");
                                    }
                                    text.push_str(t);
                                }
                            }
                            Some("tool_use") => tools.push(ToolUse {
                                name: item.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string(),
                                detail: item.get("input").map(tool_detail).unwrap_or_default(),
                            }),
                            _ => {}
                        }
                    }
                    if text.is_empty() && tools.is_empty() {
                        continue;
                    }
                    match messages.last_mut() {
                        Some(last) if last.role == "assistant" => {
                            if !text.is_empty() {
                                if !last.text.is_empty() {
                                    last.text.push_str("\n\n");
                                }
                                last.text.push_str(&text);
                                if last.text.len() > MAX_TEXT {
                                    last.text = last.text.chars().take(MAX_TEXT).collect();
                                }
                            }
                            last.tools.extend(tools);
                        }
                        _ => messages.push(Message { role: "assistant".into(), text, tools, time }),
                    }
                }
                _ => {}
            }
        }
        let total = messages.len();
        let skip = total.saturating_sub(MAX_MESSAGES);
        Ok(Transcript { messages: messages.into_iter().skip(skip).collect(), total, cwd })
    })
    .await
}

pub fn session_file(account_id: &str, session_id: &str) -> Option<PathBuf> {
    let record = accounts::record(account_id)?;
    session_files(&record)
        .into_iter()
        .map(|(path, _, _)| path)
        .find(|path| path.file_stem().and_then(|s| s.to_str()) == Some(session_id))
}

#[tauri::command]
pub async fn session_copy_to_account(session_id: String, from: String, to: String) -> Result<(), String> {
    blocking(move || {
        let source = session_file(&from, &session_id).ok_or("Файл розмови не знайдено")?;
        let from_record = accounts::record(&from).ok_or("Підписку не знайдено")?;
        let to_record = accounts::record(&to).ok_or("Підписку не знайдено")?;
        let relative = source.strip_prefix(accounts::config_dir(&from_record).join("projects")).map_err(err)?.to_path_buf();
        let target = accounts::config_dir(&to_record).join("projects").join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        fs::copy(&source, &target).map_err(err)?;
        let extras = source.with_extension("");
        if extras.is_dir() {
            let _ = copy_dir(&extras, &target.with_extension(""));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn session_exists(account_id: String, session_id: String) -> bool {
    session_file(&account_id, &session_id).is_some()
}
