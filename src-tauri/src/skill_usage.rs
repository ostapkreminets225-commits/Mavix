use crate::accounts;
use crate::paths::data_dir;
use crate::util::{blocking, err, mtime_ms, path_string, read_json, write_atomic};
use memchr::memmem;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CACHE_VERSION: u32 = 1;
const SCAN_THREADS: usize = 4;
const SESSION_DEPTH: usize = 6;
const COMMAND_OPEN: &str = "<command-name>/";
const COMMAND_CLOSE: &str = "</command-name>";

static SCAN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
struct Hit {
    skill: String,
    manual: bool,
    time: String,
    session: String,
}

#[derive(Serialize, Deserialize, Default)]
struct FileEntry {
    size: u64,
    modified: u64,
    hits: Vec<Hit>,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    files: HashMap<String, FileEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsage {
    skill: String,
    total: u32,
    auto: u32,
    manual: u32,
    sessions: u32,
    last: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    skills: Vec<SkillUsage>,
    files: usize,
    scanned: usize,
}

fn cache_file() -> PathBuf {
    data_dir().join("skill-usage.json")
}

fn collect_files(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                collect_files(&path, depth - 1, out);
            }
        } else if meta.len() > 0 && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push((path, meta.len(), mtime_ms(&meta)));
        }
    }
}

fn prompt_text(value: &Value) -> String {
    match value.pointer("/message/content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn scan_file(path: &Path) -> Vec<Hit> {
    let Ok(file) = fs::File::open(path) else { return vec![] };
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let skill_finder = memmem::Finder::new(b"\"name\":\"Skill\"");
    let command_finder = memmem::Finder::new(COMMAND_OPEN.as_bytes());
    let mut line = Vec::new();
    let mut hits = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let has_skill = skill_finder.find(&line).is_some();
        let has_command = command_finder.find(&line).is_some();
        if !has_skill && !has_command {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else { continue };
        let time = value.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let session = value.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        match value.get("type").and_then(|v| v.as_str()) {
            Some("assistant") if has_skill => {
                let Some(items) = value.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
                for item in items {
                    let is_skill = item.get("type").and_then(|t| t.as_str()) == Some("tool_use") && item.get("name").and_then(|n| n.as_str()) == Some("Skill");
                    if !is_skill {
                        continue;
                    }
                    let name = item.pointer("/input/skill").or_else(|| item.pointer("/input/command")).and_then(|s| s.as_str()).unwrap_or("");
                    let name = name.trim().trim_start_matches('/');
                    if !name.is_empty() {
                        hits.push(Hit { skill: name.to_string(), manual: false, time: time.clone(), session: session.clone() });
                    }
                }
            }
            Some("user") if has_command => {
                let text = prompt_text(&value);
                let Some(start) = text.find(COMMAND_OPEN) else { continue };
                let rest = &text[start + COMMAND_OPEN.len()..];
                let Some(end) = rest.find(COMMAND_CLOSE) else { continue };
                let name = rest[..end].trim();
                if !name.is_empty() && !name.contains(char::is_whitespace) {
                    hits.push(Hit { skill: name.to_string(), manual: true, time, session });
                }
            }
            _ => {}
        }
    }
    hits
}

fn scan_many(files: Vec<(PathBuf, u64, u64)>) -> Vec<(String, FileEntry)> {
    if files.is_empty() {
        return vec![];
    }
    let mut buckets: Vec<Vec<(PathBuf, u64, u64)>> = (0..SCAN_THREADS).map(|_| Vec::new()).collect();
    let mut sorted = files;
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    for (index, file) in sorted.into_iter().enumerate() {
        buckets[index % SCAN_THREADS].push(file);
    }
    std::thread::scope(|scope| {
        let handles: Vec<_> = buckets
            .into_iter()
            .map(|bucket| {
                scope.spawn(move || {
                    bucket
                        .into_iter()
                        .map(|(path, size, modified)| (path_string(&path), FileEntry { size, modified, hits: scan_file(&path) }))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

fn report() -> Result<UsageReport, String> {
    let _guard = SCAN_LOCK.lock().map_err(err)?;
    let mut cache: Cache = read_json(&cache_file())
        .and_then(|v| serde_json::from_value::<Cache>(v).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut seen_roots = HashSet::new();
    for record in accounts::all_records() {
        let root = accounts::config_dir(&record).join("projects");
        if seen_roots.insert(path_string(&root).to_lowercase()) {
            collect_files(&root, SESSION_DEPTH, &mut files);
        }
    }
    let live: HashSet<String> = files.iter().map(|(p, _, _)| path_string(p)).collect();
    let pending: Vec<(PathBuf, u64, u64)> = files
        .iter()
        .filter(|(path, size, modified)| cache.files.get(&path_string(path)).is_none_or(|e| e.size != *size || e.modified != *modified))
        .cloned()
        .collect();
    let scanned = pending.len();
    let before = cache.files.len();
    cache.files.retain(|key, _| live.contains(key));
    let removed = before != cache.files.len();
    for (key, entry) in scan_many(pending) {
        cache.files.insert(key, entry);
    }
    if scanned > 0 || removed {
        cache.version = CACHE_VERSION;
        if let Ok(bytes) = serde_json::to_vec(&cache) {
            let _ = write_atomic(&cache_file(), &bytes);
        }
    }
    let mut totals: HashMap<String, (u32, u32, HashSet<String>, String)> = HashMap::new();
    for entry in cache.files.values() {
        for hit in &entry.hits {
            let slot = totals.entry(hit.skill.clone()).or_insert_with(|| (0, 0, HashSet::new(), String::new()));
            if hit.manual {
                slot.1 += 1;
            } else {
                slot.0 += 1;
            }
            if !hit.session.is_empty() {
                slot.2.insert(hit.session.clone());
            }
            if hit.time > slot.3 {
                slot.3 = hit.time.clone();
            }
        }
    }
    let mut skills: Vec<SkillUsage> = totals
        .into_iter()
        .map(|(skill, (auto, manual, sessions, last))| SkillUsage { skill, total: auto + manual, auto, manual, sessions: sessions.len() as u32, last })
        .collect();
    skills.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| b.last.cmp(&a.last)));
    Ok(UsageReport { skills, files: files.len(), scanned })
}

#[tauri::command]
pub async fn skills_usage() -> Result<UsageReport, String> {
    blocking(report).await
}
