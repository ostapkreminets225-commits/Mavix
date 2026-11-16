use crate::accounts;
use crate::paths::{data_dir, main_claude_json};
use crate::util::{blocking, err, hidden, mtime_ms, now_ms, path_string, read_json, write_json};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const MCP_FLAG: &str = "--slack-mcp";
const API: &str = "https://slack.com/api/";
const SERVER: &str = "mavix-slack";
const READ_SCOPES: [&str; 9] = [
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "mpim:history",
    "mpim:read",
    "users:read",
];
const CHAT_TYPES: &str = "public_channel,private_channel,mpim,im";
const SKIPPED_SUBTYPES: [&str; 7] = ["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "group_join", "group_leave"];
const DIGEST_KINDS: [&str; 6] = ["edits", "questions", "bugs", "deadlines", "mentions", "info"];
const STRIPPED_ENV: [&str; 5] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CONFIG_DIR", "CLAUDE_AGENT_SDK_VERSION"];
const PAGE: usize = 200;
const MAX_THREADS: usize = 15;
const THREAD_LIMIT: usize = 50;
const TEXT_CAP: usize = 700;
const READ_DEFAULT_DAYS: u64 = 7;
const READ_DEFAULT_LIMIT: u64 = 150;
const READ_MAX_LIMIT: u64 = 500;
const SEARCH_DEFAULT_DAYS: u64 = 30;
const SEARCH_PER_CHAT: usize = 300;
const SEARCH_MAX_HITS: usize = 100;
const MAX_DAYS: u64 = 90;
const DIGEST_PER_CHAT: usize = 120;
const DIGEST_TOTAL: usize = 600;
const DIGEST_TIMEOUT: Duration = Duration::from_secs(240);
const DIGEST_MODEL: &str = "sonnet";
const RETRIES: u32 = 3;
const DAY: f64 = 86_400.0;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    token: String,
    team: String,
    team_id: String,
    url: String,
    user: String,
    user_id: String,
    scopes: Vec<String>,
    selected: Vec<Chat>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Chat {
    id: String,
    name: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    label: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackState {
    connected: bool,
    team: String,
    url: String,
    user: String,
    scopes: Vec<String>,
    selected: Vec<Chat>,
    targets: Vec<Target>,
    digest: Option<Value>,
    read_scopes: Vec<String>,
}

#[derive(Clone)]
struct Msg {
    chat: String,
    ts: String,
    user: String,
    text: String,
    link: String,
    mention: bool,
    reply: bool,
    replies: Vec<Msg>,
}

struct Reply {
    body: Value,
    scopes: Option<String>,
}

struct Names {
    map: HashMap<String, String>,
    token: String,
    dirty: bool,
}

impl Names {
    fn new(cfg: &Config) -> Self {
        Names { map: load_users(), token: cfg.token.clone(), dirty: false }
    }

    fn get(&mut self, id: &str) -> String {
        if let Some(name) = self.map.get(id) {
            return name.clone();
        }
        let name = call(&self.token, "users.info", &[("user", id)])
            .ok()
            .map(|reply| user_name(&reply.body["user"]))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| id.to_string());
        self.map.insert(id.to_string(), name.clone());
        self.dirty = true;
        name
    }

    fn persist(&self) {
        if self.dirty {
            let _ = write_json(&users_file(), &json!(self.map));
        }
    }
}

fn slack_dir() -> PathBuf {
    let dir = data_dir().join("slack");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn config_file() -> PathBuf {
    slack_dir().join("config.json")
}

fn users_file() -> PathBuf {
    slack_dir().join("users.json")
}

fn digest_file() -> PathBuf {
    slack_dir().join("digest.json")
}

fn load() -> Config {
    read_json(&config_file()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save(cfg: &Config) -> Result<(), String> {
    write_json(&config_file(), &serde_json::to_value(cfg).map_err(err)?)
}

fn load_users() -> HashMap<String, String> {
    read_json(&users_file()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn connected(cfg: &Config) -> bool {
    !cfg.token.is_empty()
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .into()
    })
}

fn call(token: &str, method: &str, params: &[(&str, &str)]) -> Result<Reply, String> {
    let url = format!("{API}{method}");
    for attempt in 0..=RETRIES {
        let mut request = agent().get(&url).header("Authorization", format!("Bearer {token}"));
        for (key, value) in params {
            request = request.query(*key, *value);
        }
        let mut response = request.call().map_err(|e| format!("Slack недоступний: {e}"))?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let scopes = response.headers().get("x-oauth-scopes").and_then(|v| v.to_str().ok()).map(String::from);
        if status == 429 {
            if attempt < RETRIES {
                std::thread::sleep(Duration::from_secs(retry_after.unwrap_or(3).min(30)));
                continue;
            }
            break;
        }
        let body: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| format!("Slack повернув незрозумілу відповідь ({status}): {e}"))?;
        if body.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(Reply { body, scopes });
        }
        let code = body.get("error").and_then(Value::as_str).unwrap_or("unknown_error");
        if code == "ratelimited" && attempt < RETRIES {
            std::thread::sleep(Duration::from_secs(3));
            continue;
        }
        return Err(slack_error(code, &body));
    }
    Err("Slack просить зачекати: забагато запитів. Спробуй за хвилину".into())
}

fn slack_error(code: &str, body: &Value) -> String {
    match code {
        "invalid_auth" | "not_authed" | "account_inactive" | "token_revoked" | "token_expired" => "Токен Slack не підходить або відкликаний. Встав новий".into(),
        "missing_scope" => format!("Токену бракує прав: {}", body.get("needed").and_then(Value::as_str).unwrap_or("невідомо")),
        "channel_not_found" => "Чат не знайдено або до нього немає доступу".into(),
        "not_in_channel" => "Ти не учасник цього каналу".into(),
        "ratelimited" => "Slack просить зачекати: забагато запитів".into(),
        other => format!("Slack: {other}"),
    }
}

fn next_cursor(body: &Value) -> String {
    body["response_metadata"]["next_cursor"].as_str().unwrap_or("").to_string()
}

fn user_name(member: &Value) -> String {
    let profile = &member["profile"];
    [profile["display_name"].as_str(), profile["real_name"].as_str(), member["real_name"].as_str(), member["name"].as_str()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or("")
        .to_string()
}

fn refresh_users(token: &str) -> Result<HashMap<String, String>, String> {
    let mut map = load_users();
    let limit = PAGE.to_string();
    let mut cursor = String::new();
    loop {
        let mut params = vec![("limit", limit.as_str())];
        if !cursor.is_empty() {
            params.push(("cursor", cursor.as_str()));
        }
        let reply = call(token, "users.list", &params)?;
        for member in reply.body["members"].as_array().into_iter().flatten() {
            if let Some(id) = member["id"].as_str() {
                let name = user_name(member);
                if !name.is_empty() {
                    map.insert(id.to_string(), name);
                }
            }
        }
        let next = next_cursor(&reply.body);
        if next.is_empty() {
            break;
        }
        cursor = next;
    }
    let _ = write_json(&users_file(), &json!(map));
    Ok(map)
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "channel" => 0,
        "private" => 1,
        "group" => 2,
        _ => 3,
    }
}

fn group_name(raw: &str) -> String {
    let core = raw.trim_start_matches("mpdm-");
    let core = core.rsplit_once('-').map(|(head, _)| head).unwrap_or(core);
    core.split("--").collect::<Vec<_>>().join(", ")
}

fn to_chat(channel: &Value, users: &HashMap<String, String>) -> Option<Chat> {
    let id = channel["id"].as_str()?.to_string();
    if channel["is_im"].as_bool() == Some(true) {
        if channel["is_user_deleted"].as_bool() == Some(true) {
            return None;
        }
        let user = channel["user"].as_str().unwrap_or("");
        if user == "USLACKBOT" {
            return None;
        }
        let name = users.get(user).cloned().unwrap_or_else(|| user.to_string());
        return Some(Chat { id, name, kind: "dm".into() });
    }
    let raw = channel["name"].as_str().unwrap_or(&id).to_string();
    if channel["is_mpim"].as_bool() == Some(true) {
        return Some(Chat { id, name: group_name(&raw), kind: "group".into() });
    }
    let kind = if channel["is_private"].as_bool() == Some(true) { "private" } else { "channel" };
    Some(Chat { id, name: raw, kind: kind.into() })
}

fn list_chats(cfg: &Config) -> Result<Vec<Chat>, String> {
    let users = refresh_users(&cfg.token).unwrap_or_else(|_| load_users());
    let limit = PAGE.to_string();
    let mut cursor = String::new();
    let mut out = Vec::new();
    loop {
        let mut params = vec![("types", CHAT_TYPES), ("exclude_archived", "true"), ("limit", limit.as_str())];
        if !cursor.is_empty() {
            params.push(("cursor", cursor.as_str()));
        }
        let reply = call(&cfg.token, "users.conversations", &params)?;
        out.extend(reply.body["channels"].as_array().into_iter().flatten().filter_map(|c| to_chat(c, &users)));
        let next = next_cursor(&reply.body);
        if next.is_empty() {
            break;
        }
        cursor = next;
    }
    out.sort_by(|a, b| kind_rank(&a.kind).cmp(&kind_rank(&b.kind)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

fn label(chat: &Chat) -> String {
    match chat.kind.as_str() {
        "dm" => format!("@{}", chat.name),
        "group" => chat.name.clone(),
        _ => format!("#{}", chat.name),
    }
}

fn now_secs() -> f64 {
    now_ms() as f64 / 1000.0
}

fn when(ts: &str) -> String {
    let secs = ts.split('.').next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    Local.timestamp_opt(secs, 0).single().map(|t| t.format("%d.%m %H:%M").to_string()).unwrap_or_default()
}

fn permalink(cfg: &Config, chat_id: &str, ts: &str, thread: Option<&str>) -> String {
    let base = if cfg.url.is_empty() {
        "https://slack.com/".to_string()
    } else if cfg.url.ends_with('/') {
        cfg.url.clone()
    } else {
        format!("{}/", cfg.url)
    };
    let mut link = format!("{base}archives/{chat_id}/p{}", ts.replace('.', ""));
    if let Some(parent) = thread {
        link.push_str(&format!("?thread_ts={parent}&cid={chat_id}"));
    }
    link
}

fn clean(raw: &str, names: &mut Names) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let inner = &after[..end];
        let (target, title) = match inner.split_once('|') {
            Some((target, title)) => (target, Some(title)),
            None => (inner, None),
        };
        let piece = if let Some(id) = target.strip_prefix('@') {
            format!("@{}", title.map(String::from).unwrap_or_else(|| names.get(id)))
        } else if let Some(id) = target.strip_prefix('#') {
            format!("#{}", title.unwrap_or(id))
        } else if let Some(special) = target.strip_prefix('!') {
            format!("@{}", title.unwrap_or_else(|| special.split('^').next().unwrap_or(special)))
        } else {
            match title {
                Some(title) if title != target => format!("{title} ({target})"),
                _ => target.to_string(),
            }
        };
        out.push_str(&piece);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn to_msg(cfg: &Config, chat: &Chat, message: &Value, names: &mut Names) -> Msg {
    let ts = message["ts"].as_str().unwrap_or("").to_string();
    let user = match message["user"].as_str() {
        Some(id) => names.get(id),
        None => message["username"].as_str().or(message["bot_profile"]["name"].as_str()).unwrap_or("бот").to_string(),
    };
    let raw = message["text"].as_str().unwrap_or("");
    let mention = !cfg.user_id.is_empty() && raw.contains(&format!("<@{}", cfg.user_id));
    let mut text = clean(raw, names);
    for file in message["files"].as_array().into_iter().flatten() {
        text.push_str(&format!(" [файл: {}]", file["name"].as_str().unwrap_or("файл")));
    }
    if text.chars().count() > TEXT_CAP {
        text = text.chars().take(TEXT_CAP).collect::<String>() + "…";
    }
    let parent = message["thread_ts"].as_str().filter(|parent| *parent != ts);
    let link = permalink(cfg, &chat.id, &ts, parent);
    Msg { chat: label(chat), ts, user, text, link, mention, reply: parent.is_some(), replies: Vec::new() }
}

fn fetch_replies(cfg: &Config, chat: &Chat, ts: &str, names: &mut Names) -> Result<Vec<Msg>, String> {
    let limit = THREAD_LIMIT.to_string();
    let reply = call(&cfg.token, "conversations.replies", &[("channel", chat.id.as_str()), ("ts", ts), ("limit", limit.as_str())])?;
    Ok(reply.body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["ts"].as_str() != Some(ts))
        .map(|m| to_msg(cfg, chat, m, names))
        .collect())
}

fn fetch(cfg: &Config, chat: &Chat, oldest: f64, limit: usize, threads: bool, names: &mut Names) -> Result<Vec<Msg>, String> {
    let oldest = format!("{oldest:.6}");
    let mut raw: Vec<Value> = Vec::new();
    let mut cursor = String::new();
    while raw.len() < limit {
        let page = PAGE.min(limit - raw.len()).to_string();
        let mut params = vec![("channel", chat.id.as_str()), ("oldest", oldest.as_str()), ("limit", page.as_str())];
        if !cursor.is_empty() {
            params.push(("cursor", cursor.as_str()));
        }
        let reply = call(&cfg.token, "conversations.history", &params)?;
        raw.extend(reply.body["messages"].as_array().cloned().unwrap_or_default());
        let next = next_cursor(&reply.body);
        if next.is_empty() || reply.body["has_more"].as_bool() != Some(true) {
            break;
        }
        cursor = next;
    }
    raw.retain(|m| !m["subtype"].as_str().is_some_and(|s| SKIPPED_SUBTYPES.contains(&s)));
    let mut threads_left = if threads { MAX_THREADS } else { 0 };
    let mut out = Vec::with_capacity(raw.len());
    for message in &raw {
        let mut msg = to_msg(cfg, chat, message, names);
        if threads_left > 0 && message["reply_count"].as_u64().unwrap_or(0) > 0 {
            threads_left -= 1;
            if let Ok(replies) = fetch_replies(cfg, chat, &msg.ts, names) {
                msg.replies = replies;
            }
        }
        out.push(msg);
    }
    out.reverse();
    Ok(out)
}

fn render_line(msg: &Msg) -> String {
    format!("[{}] {}: {}", when(&msg.ts), msg.user, msg.text.replace('\n', "\n    "))
}

fn render(msgs: &[Msg]) -> String {
    let mut out = String::new();
    for msg in msgs {
        out.push_str(&render_line(msg));
        out.push('\n');
        for reply in &msg.replies {
            out.push_str("    ↳ ");
            out.push_str(&render_line(reply).replace('\n', "\n      "));
            out.push('\n');
        }
    }
    out
}

fn find_chat<'a>(cfg: &'a Config, query: &str) -> Option<&'a Chat> {
    let q = query.trim().trim_start_matches(['#', '@']).to_lowercase();
    if q.is_empty() {
        return None;
    }
    cfg.selected
        .iter()
        .find(|c| c.id.to_lowercase() == q)
        .or_else(|| cfg.selected.iter().find(|c| c.name.to_lowercase() == q))
        .or_else(|| cfg.selected.iter().find(|c| c.name.to_lowercase().contains(&q)))
}

fn number(params: &Value, key: &str, default: u64, max: u64) -> u64 {
    params[key].as_u64().or_else(|| params[key].as_f64().map(|v| v as u64)).unwrap_or(default).clamp(1, max)
}

fn not_allowed(query: &str) -> String {
    format!("Chat \"{query}\" is not allowed in Mavix. Only the chats the user ticked in the Mavix Slack panel can be read; ask the user to tick it there.")
}

fn tool_chats(cfg: &Config) -> Result<String, String> {
    if cfg.selected.is_empty() {
        return Ok("The user has not allowed any Slack chats yet. They can tick chats in the Slack panel of Mavix.".into());
    }
    let mut out = format!("Slack workspace: {} · user: {}\nAllowed chats (read-only):\n", cfg.team, cfg.user);
    for chat in &cfg.selected {
        let kind = match chat.kind.as_str() {
            "dm" => "direct message",
            "group" => "group DM",
            "private" => "private channel",
            _ => "channel",
        };
        out.push_str(&format!("- {} ({kind}, id {})\n", label(chat), chat.id));
    }
    Ok(out)
}

fn tool_read(cfg: &Config, params: &Value) -> Result<String, String> {
    let query = params["chat"].as_str().unwrap_or("");
    let chat = find_chat(cfg, query).ok_or_else(|| not_allowed(query))?;
    let days = number(params, "days", READ_DEFAULT_DAYS, MAX_DAYS);
    let limit = number(params, "limit", READ_DEFAULT_LIMIT, READ_MAX_LIMIT) as usize;
    let mut names = Names::new(cfg);
    let msgs = fetch(cfg, chat, now_secs() - days as f64 * DAY, limit, true, &mut names)?;
    names.persist();
    if msgs.is_empty() {
        return Ok(format!("{}: no messages in the last {days} days.", label(chat)));
    }
    Ok(format!("{} · last {days} days · {} messages (oldest first)\n\n{}", label(chat), msgs.len(), render(&msgs)))
}

fn tool_search(cfg: &Config, params: &Value) -> Result<String, String> {
    let query = params["query"].as_str().unwrap_or("").trim().to_lowercase();
    if query.is_empty() {
        return Err("query is empty".into());
    }
    let days = number(params, "days", SEARCH_DEFAULT_DAYS, MAX_DAYS);
    let chats: Vec<&Chat> = match params["chat"].as_str().filter(|c| !c.trim().is_empty()) {
        Some(name) => vec![find_chat(cfg, name).ok_or_else(|| not_allowed(name))?],
        None => cfg.selected.iter().collect(),
    };
    let mut names = Names::new(cfg);
    let mut hits = Vec::new();
    let mut failed = Vec::new();
    for chat in chats {
        match fetch(cfg, chat, now_secs() - days as f64 * DAY, SEARCH_PER_CHAT, true, &mut names) {
            Ok(msgs) => {
                for msg in msgs {
                    if msg.text.to_lowercase().contains(&query) {
                        hits.push(msg.clone());
                    }
                    hits.extend(msg.replies.iter().filter(|r| r.text.to_lowercase().contains(&query)).cloned());
                }
            }
            Err(e) => failed.push(format!("{}: {e}", label(chat))),
        }
    }
    names.persist();
    let total = hits.len();
    let mut out = format!("Search \"{query}\" · last {days} days · {total} matches\n\n");
    for msg in hits.iter().rev().take(SEARCH_MAX_HITS) {
        out.push_str(&format!("{} {}\n  {}\n", msg.chat, render_line(msg), msg.link));
    }
    if total > SEARCH_MAX_HITS {
        out.push_str(&format!("\n…showing the newest {SEARCH_MAX_HITS} of {total}.\n"));
    }
    if !failed.is_empty() {
        out.push_str(&format!("\nCould not read: {}\n", failed.join("; ")));
    }
    Ok(out)
}

fn tool_digest() -> Result<String, String> {
    let Some(digest) = read_json(&digest_file()) else {
        return Ok("No digest yet. The user can build one in the Mavix Slack panel («Що нового»).".into());
    };
    let created = digest["createdAt"].as_u64().unwrap_or(0) as i64;
    let at = Local.timestamp_millis_opt(created).single().map(|t| t.format("%d.%m %H:%M").to_string()).unwrap_or_default();
    let mut out = format!("Digest from {at}, last {} days, {} messages.\n{}\n", digest["days"], digest["count"], digest["summary"].as_str().unwrap_or(""));
    for group in digest["groups"].as_array().into_iter().flatten() {
        out.push_str(&format!("\n## {}\n", group["kind"].as_str().unwrap_or("")));
        for item in group["items"].as_array().into_iter().flatten() {
            out.push_str(&format!("- {}\n", item["text"].as_str().unwrap_or("")));
            for r in item["refs"].as_array().into_iter().flatten() {
                out.push_str(&format!("  · {} {} {}: {}\n", r["chat"].as_str().unwrap_or(""), r["time"].as_str().unwrap_or(""), r["user"].as_str().unwrap_or(""), r["link"].as_str().unwrap_or("")));
            }
        }
    }
    Ok(out)
}

fn tool_defs() -> Value {
    let read_only = json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": true });
    json!([
        {
            "name": "slack_chats",
            "description": "List the Slack chats the user allowed in Mavix. Read-only: there is no way to post, reply, react or change anything in Slack.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only
        },
        {
            "name": "slack_read",
            "description": "Read recent messages (with thread replies) from one allowed Slack chat, oldest first. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "chat": { "type": "string", "description": "Chat name (#channel, @person, group) or id from slack_chats" },
                    "days": { "type": "integer", "minimum": 1, "maximum": MAX_DAYS, "default": READ_DEFAULT_DAYS },
                    "limit": { "type": "integer", "minimum": 1, "maximum": READ_MAX_LIMIT, "default": READ_DEFAULT_LIMIT }
                },
                "required": ["chat"]
            },
            "annotations": read_only
        },
        {
            "name": "slack_search",
            "description": "Find messages containing a word or phrase in the allowed Slack chats (or one of them). Returns matches with links. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "chat": { "type": "string", "description": "Optional: limit to one allowed chat" },
                    "days": { "type": "integer", "minimum": 1, "maximum": MAX_DAYS, "default": SEARCH_DEFAULT_DAYS }
                },
                "required": ["query"]
            },
            "annotations": read_only
        },
        {
            "name": "slack_digest",
            "description": "The latest digest the user built in Mavix: requested edits, questions for the user, bugs, deadlines, mentions, with links. Read-only.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only
        }
    ])
}

fn call_tool(params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let cfg = load();
    let result = if !connected(&cfg) {
        Err("Slack is not connected in Mavix. The user can connect it in the Slack panel.".to_string())
    } else {
        match name {
            "slack_chats" => tool_chats(&cfg),
            "slack_read" => tool_read(&cfg, &args),
            "slack_search" => tool_search(&cfg, &args),
            "slack_digest" => tool_digest(),
            other => Err(format!("Unknown tool {other}")),
        }
    };
    match result {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
        Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
    }
}

pub fn run_mcp() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().unwrap_or("");
        let Some(id) = message.get("id").cloned() else { continue };
        let reply = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Read-only access to the Slack chats the user ticked in the Mavix IDE. You can only read. You cannot post, reply, react, edit or change anything in Slack, and you must never offer to send Slack messages for the user."
                }
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tool_defs() } }),
            "tools/call" => json!({ "jsonrpc": "2.0", "id": id, "result": call_tool(&message["params"]) }),
            "resources/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "resources": [] } }),
            "prompts/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "prompts": [] } }),
            other => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {other}") } }),
        };
        if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
            break;
        }
    }
}

fn mcp_exe() -> PathBuf {
    data_dir().join("bin").join("mavix-slack.exe")
}

fn ensure_mcp_exe() -> Result<PathBuf, String> {
    let source = std::env::current_exe().map_err(err)?;
    let target = mcp_exe();
    let bin = target.parent().map(Path::to_path_buf).ok_or("Немає папки для сервера Slack")?;
    fs::create_dir_all(&bin).map_err(err)?;
    let meta = fs::metadata(&source).map_err(err)?;
    let stamp = format!("{}-{}", meta.len(), mtime_ms(&meta));
    let stamp_file = bin.join("mavix-slack.stamp");
    if target.is_file() && fs::read_to_string(&stamp_file).unwrap_or_default().trim() == stamp {
        return Ok(target);
    }
    for entry in fs::read_dir(&bin).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with("mavix-slack.old-") {
            let _ = fs::remove_file(entry.path());
        }
    }
    let temp = bin.join("mavix-slack.exe.new");
    fs::copy(&source, &temp).map_err(err)?;
    if target.exists() && fs::remove_file(&target).is_err() {
        fs::rename(&target, bin.join(format!("mavix-slack.old-{}.exe", now_ms()))).map_err(err)?;
    }
    fs::rename(&temp, &target).map_err(err)?;
    let _ = fs::write(&stamp_file, stamp);
    Ok(target)
}

fn claude_command(account_dir: Option<&Path>) -> Result<Command, String> {
    let program = crate::chat::claude_program().ok_or("Не знайдено claude. Встанови Claude Code")?;
    let is_script = program.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    let mut command = if is_script {
        let mut shell = hidden("cmd.exe");
        shell.arg("/C").arg(&program);
        shell
    } else {
        hidden(&program.to_string_lossy())
    };
    for key in STRIPPED_ENV {
        command.env_remove(key);
    }
    if let Some(dir) = account_dir {
        command.env("CLAUDE_CONFIG_DIR", dir);
    }
    command.current_dir(slack_dir());
    Ok(command)
}

fn run_claude(args: &[&str], account_dir: Option<&Path>) -> Result<String, String> {
    let output = claude_command(account_dir)?.args(args).stdin(Stdio::null()).output().map_err(err)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

fn server_entry(file: &Path) -> Option<Value> {
    read_json(file)?.get("mcpServers")?.get(SERVER).cloned()
}

fn register(on: bool) -> Vec<Target> {
    let exe = if on { ensure_mcp_exe() } else { Ok(mcp_exe()) };
    accounts::all_records()
        .iter()
        .map(|record| {
            let dir = accounts::extra_config_dir(&record.id);
            let file = dir.as_ref().map(|d| d.join(".claude.json")).unwrap_or_else(main_claude_json);
            let entry = server_entry(&file);
            let result = match (&exe, on) {
                (Err(e), true) => Err(format!("Не вдалося підготувати сервер Slack: {e}")),
                (Ok(exe), true) => {
                    let command = path_string(exe);
                    let current = entry.as_ref().is_some_and(|e| e["command"].as_str() == Some(command.as_str()) && e["args"][0].as_str() == Some(MCP_FLAG));
                    if current {
                        Ok(())
                    } else {
                        if entry.is_some() {
                            let _ = run_claude(&["mcp", "remove", SERVER, "-s", "user"], dir.as_deref());
                        }
                        let spec = json!({ "type": "stdio", "command": command, "args": [MCP_FLAG] }).to_string();
                        run_claude(&["mcp", "add-json", SERVER, &spec, "-s", "user"], dir.as_deref()).map(|_| ())
                    }
                }
                (_, false) => {
                    if entry.is_some() {
                        run_claude(&["mcp", "remove", SERVER, "-s", "user"], dir.as_deref()).map(|_| ())
                    } else {
                        Ok(())
                    }
                }
            };
            Target { label: record.label.clone(), ok: result.is_ok(), error: result.err() }
        })
        .collect()
}

fn state(cfg: &Config, targets: Vec<Target>) -> SlackState {
    SlackState {
        connected: connected(cfg),
        team: cfg.team.clone(),
        url: cfg.url.clone(),
        user: cfg.user.clone(),
        scopes: cfg.scopes.clone(),
        selected: cfg.selected.clone(),
        targets,
        digest: if connected(cfg) { read_json(&digest_file()) } else { None },
        read_scopes: READ_SCOPES.iter().map(|s| s.to_string()).collect(),
    }
}

fn write_scopes(scopes: &[String]) -> Vec<String> {
    scopes
        .iter()
        .filter(|s| s.contains("write") || s.starts_with("admin") || matches!(s.as_str(), "client" | "post" | "bot"))
        .cloned()
        .collect()
}

#[tauri::command]
pub async fn slack_load() -> Result<SlackState, String> {
    blocking(|| {
        let cfg = load();
        let targets = register(connected(&cfg));
        Ok(state(&cfg, targets))
    })
    .await
}

#[tauri::command]
pub async fn slack_connect(token: String) -> Result<SlackState, String> {
    blocking(move || {
        let token = token.trim().to_string();
        if token.starts_with("xoxb-") {
            return Err("Це бот-токен (xoxb-). Потрібен User OAuth Token, що починається з xoxp-".into());
        }
        if !token.starts_with("xoxp-") {
            return Err("Потрібен User OAuth Token, що починається з xoxp-".into());
        }
        let reply = call(&token, "auth.test", &[])?;
        let scopes: Vec<String> = reply.scopes.unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let writes = write_scopes(&scopes);
        if !writes.is_empty() {
            return Err(format!(
                "Токен має право писати в Slack ({}). Mavix приймає лише токен для читання: прибери ці права в налаштуваннях апки й перевстанови її",
                writes.join(", ")
            ));
        }
        let missing: Vec<&str> = READ_SCOPES.iter().copied().filter(|s| !scopes.iter().any(|have| have == s)).collect();
        if !missing.is_empty() {
            return Err(format!("Токену бракує прав на читання: {}", missing.join(", ")));
        }
        let body = &reply.body;
        let previous = load();
        let team_id = body["team_id"].as_str().unwrap_or("").to_string();
        let user_id = body["user_id"].as_str().unwrap_or("").to_string();
        let same = previous.team_id == team_id && previous.user_id == user_id;
        let mut cfg = Config {
            token,
            team: body["team"].as_str().unwrap_or("").to_string(),
            team_id,
            url: body["url"].as_str().unwrap_or("").to_string(),
            user: body["user"].as_str().unwrap_or("").to_string(),
            user_id,
            scopes,
            selected: if same { previous.selected } else { Vec::new() },
        };
        if let Ok(info) = call(&cfg.token, "users.info", &[("user", cfg.user_id.as_str())]) {
            let name = user_name(&info.body["user"]);
            if !name.is_empty() {
                cfg.user = name;
            }
        }
        if !same {
            let _ = fs::remove_file(digest_file());
        }
        save(&cfg)?;
        let targets = register(true);
        Ok(state(&cfg, targets))
    })
    .await
}

#[tauri::command]
pub async fn slack_disconnect() -> Result<SlackState, String> {
    blocking(|| {
        let targets = register(false);
        let _ = fs::remove_file(config_file());
        let _ = fs::remove_file(digest_file());
        let _ = fs::remove_file(users_file());
        Ok(state(&Config::default(), targets))
    })
    .await
}

#[tauri::command]
pub async fn slack_chats() -> Result<Vec<Chat>, String> {
    blocking(|| {
        let cfg = load();
        if !connected(&cfg) {
            return Err("Slack не підключено".into());
        }
        list_chats(&cfg)
    })
    .await
}

#[tauri::command]
pub async fn slack_select(chats: Vec<Chat>) -> Result<SlackState, String> {
    blocking(move || {
        let mut cfg = load();
        if !connected(&cfg) {
            return Err("Slack не підключено".into());
        }
        cfg.selected = chats;
        save(&cfg)?;
        Ok(state(&cfg, Vec::new()))
    })
    .await
}

fn digest_prompt(cfg: &Config, days: u64, lines: &str) -> String {
    format!(
        "Ти робиш зведення робочого Slack для {user} (Slack id {id}, у тексті може бути як @{user}). Нижче повідомлення з чатів, які {user} вибрав, за останні {days} дн. Кожне має номер у квадратних дужках.\n\n\
Знайди, що важливо для {user}, і розклади по групах:\n\
- edits: правки й зміни, які просять зробити (у дизайні, коді, білді, тексті, грі);\n\
- questions: питання, на які чекають відповіді від {user};\n\
- bugs: баги, поломки, скарги;\n\
- deadlines: терміни, дедлайни, зустрічі, релізи;\n\
- mentions: згадки {user}, що не потрапили вище;\n\
- info: інші важливі новини й рішення.\n\n\
Кожен пункт: одне коротке речення українською: хто, що просить, де. Об'єднуй повтори в один пункт. У refs вказуй номери повідомлень, на яких пункт ґрунтується. Нічого не вигадуй. Порожні групи пропускай. summary: 1–2 речення про головне.\n\n\
Відповідай ЛИШЕ JSON, без пояснень і без ```:\n\
{{\"summary\": \"...\", \"groups\": [{{\"kind\": \"edits\", \"items\": [{{\"text\": \"...\", \"refs\": [3, 7]}}]}}]}}\n\n\
Повідомлення:\n{lines}",
        user = cfg.user,
        id = cfg.user_id,
    )
}

fn run_digest_claude(prompt: &str, account_dir: Option<&Path>) -> Result<String, String> {
    let mut child = claude_command(account_dir)?
        .args(["-p", "--model", DIGEST_MODEL, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    let mut stdin = child.stdin.take().ok_or("Не вдалося передати повідомлення в Claude")?;
    let text = prompt.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(text.as_bytes());
    });
    let mut stdout = child.stdout.take().ok_or("Немає відповіді від Claude")?;
    let mut stderr = child.stderr.take().ok_or("Немає відповіді від Claude")?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let errors = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stderr.read_to_string(&mut out);
        out
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(err)? {
            break status;
        }
        if started.elapsed() > DIGEST_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Claude не встиг зробити зведення за 4 хвилини".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let _ = writer.join();
    let out = reader.join().unwrap_or_default();
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        let reason = if errors.trim().is_empty() { out.trim() } else { errors.trim() };
        return Err(format!("Claude не зміг зробити зведення: {}", reason.chars().take(400).collect::<String>()));
    }
    Ok(out)
}

fn parse_digest(output: &str) -> Result<Value, String> {
    let start = output.find('{').ok_or("Claude відповів не у форматі JSON")?;
    let end = output.rfind('}').ok_or("Claude відповів не у форматі JSON")?;
    serde_json::from_str(&output[start..=end]).map_err(|e| format!("Не вдалося прочитати зведення Claude: {e}"))
}

fn add_line(msg: Msg, flat: &mut Vec<Msg>, lines: &mut String) {
    let n = flat.len() + 1;
    let marks = format!("{}{}", if msg.reply { " (у треді)" } else { "" }, if msg.mention { " (згадує тебе)" } else { "" });
    lines.push_str(&format!("[{n}] {} · {} · {}{marks}: {}\n", msg.chat, when(&msg.ts), msg.user, msg.text.replace('\n', " ")));
    flat.push(msg);
}

fn flatten(mut msg: Msg, flat: &mut Vec<Msg>, lines: &mut String) {
    let replies = std::mem::take(&mut msg.replies);
    add_line(msg, flat, lines);
    for reply in replies {
        add_line(reply, flat, lines);
    }
}

fn make_digest(cfg: &Config, account: Option<String>, days: u64) -> Result<Value, String> {
    if cfg.selected.is_empty() {
        return Err("Спершу вибери чати, які Claude може читати".into());
    }
    let oldest = now_secs() - days as f64 * DAY;
    let mut names = Names::new(cfg);
    let mut flat: Vec<Msg> = Vec::new();
    let mut lines = String::new();
    let mut failed = Vec::new();
    for chat in &cfg.selected {
        if flat.len() >= DIGEST_TOTAL {
            break;
        }
        match fetch(cfg, chat, oldest, DIGEST_PER_CHAT, true, &mut names) {
            Ok(msgs) => {
                for msg in msgs {
                    flatten(msg, &mut flat, &mut lines);
                }
            }
            Err(e) => failed.push(format!("{}: {e}", label(chat))),
        }
    }
    names.persist();
    let created = now_ms();
    let digest = if flat.is_empty() {
        json!({ "createdAt": created, "days": days, "count": 0, "summary": "За цей час у вибраних чатах нових повідомлень немає.", "groups": [], "failed": failed })
    } else {
        let account_dir = account.as_deref().and_then(accounts::extra_config_dir);
        let output = run_digest_claude(&digest_prompt(cfg, days, &lines), account_dir.as_deref())?;
        let parsed = parse_digest(&output)?;
        let mut groups = Vec::new();
        for kind in DIGEST_KINDS {
            let items: Vec<Value> = parsed["groups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|g| g["kind"].as_str() == Some(kind))
                .flat_map(|g| g["items"].as_array().cloned().unwrap_or_default())
                .filter_map(|item| {
                    let text = item["text"].as_str()?.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    let refs: Vec<Value> = item["refs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|r| r.as_u64())
                        .filter_map(|n| flat.get((n as usize).checked_sub(1)?))
                        .map(|m| json!({ "chat": m.chat, "user": m.user, "time": when(&m.ts), "link": m.link, "mention": m.mention }))
                        .collect();
                    Some(json!({ "text": text, "refs": refs }))
                })
                .collect();
            if !items.is_empty() {
                groups.push(json!({ "kind": kind, "items": items }));
            }
        }
        json!({
            "createdAt": created,
            "days": days,
            "count": flat.len(),
            "summary": parsed["summary"].as_str().unwrap_or("").trim(),
            "groups": groups,
            "failed": failed
        })
    };
    write_json(&digest_file(), &digest)?;
    Ok(digest)
}

#[tauri::command]
pub async fn slack_digest(account_id: Option<String>, days: Option<u64>) -> Result<SlackState, String> {
    blocking(move || {
        let cfg = load();
        if !connected(&cfg) {
            return Err("Slack не підключено".into());
        }
        make_digest(&cfg, account_id, days.unwrap_or(3).clamp(1, 14))?;
        Ok(state(&cfg, Vec::new()))
    })
    .await
}
