use crate::paths::{data_dir, main_claude_dir, main_claude_json};
use crate::util::{blocking, err, is_link, make_junction, now_ms, path_string, powershell, read_json, to_recycle_bin, write_atomic, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAIN_ID: &str = "main";
const SHARED_DIRS: [&str; 5] = ["skills", "agents", "commands", "plugins", "hooks"];
const COPIED_FILES: [&str; 2] = ["CLAUDE.md", "settings.json"];
const PALETTE: [&str; 6] = ["#ff8a3d", "#7fd6c2", "#6aa9ff", "#c49bff", "#e5c07b", "#ff7a90"];
const USAGE_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $headers = @{ Authorization = 'Bearer ' + $env:MAVIX_TOKEN; 'anthropic-beta' = 'oauth-2025-04-20' }; $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://api.anthropic.com/api/oauth/usage' -Headers $headers -TimeoutSec 20; $response.Content";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub label: String,
    pub color: String,
    #[serde(default)]
    pub config_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountsFile {
    #[serde(default)]
    accounts: Vec<AccountRecord>,
    #[serde(default)]
    default_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    kind: String,
    label: String,
    percent: f64,
    resets_at: Option<String>,
    severity: String,
    active: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    fetched_at: u64,
    live: bool,
    limits: Vec<Limit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    id: String,
    label: String,
    color: String,
    config_dir: String,
    main: bool,
    default: bool,
    logged_in: bool,
    email: Option<String>,
    organization: Option<String>,
    plan: Option<String>,
    token_expires_at: Option<u64>,
    usage: Option<Usage>,
    shared: bool,
}

fn accounts_file() -> PathBuf {
    data_dir().join("accounts.json")
}

fn load() -> AccountsFile {
    let mut file: AccountsFile = fs::read_to_string(accounts_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    if !file.accounts.iter().any(|a| a.id == MAIN_ID) {
        file.accounts.insert(
            0,
            AccountRecord { id: MAIN_ID.into(), label: "Основний".into(), color: PALETTE[0].into(), config_dir: None },
        );
    }
    file
}

fn save(file: &AccountsFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(file).map_err(err)?;
    write_atomic(&accounts_file(), text.as_bytes())
}

pub fn config_dir(record: &AccountRecord) -> PathBuf {
    match &record.config_dir {
        Some(dir) => PathBuf::from(dir),
        None => main_claude_dir(),
    }
}

fn claude_json(record: &AccountRecord) -> PathBuf {
    match &record.config_dir {
        Some(dir) => PathBuf::from(dir).join(".claude.json"),
        None => main_claude_json(),
    }
}

pub fn all_records() -> Vec<AccountRecord> {
    load().accounts
}

pub fn record(id: &str) -> Option<AccountRecord> {
    load().accounts.into_iter().find(|a| a.id == id)
}

pub fn extra_config_dir(id: &str) -> Option<PathBuf> {
    record(id).and_then(|a| a.config_dir.map(PathBuf::from))
}

fn limit_label(kind: &str, model: Option<&str>) -> String {
    match kind {
        "session" | "five_hour" => "Сесія (5 год)".into(),
        "weekly_all" | "seven_day" => "Тиждень (7 днів)".into(),
        "weekly_scoped" => format!("Ліміт {}", model.unwrap_or("моделі")),
        "seven_day_opus" => "Тиждень · Opus".into(),
        "seven_day_sonnet" => "Тиждень · Sonnet".into(),
        other => other.replace('_', " "),
    }
}

fn parse_usage(utilization: &Value, fetched_at: u64, live: bool) -> Option<Usage> {
    let mut limits = Vec::new();
    if let Some(list) = utilization.get("limits").and_then(|l| l.as_array()) {
        for item in list {
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("limit");
            let model = item.pointer("/scope/model/display_name").and_then(|v| v.as_str());
            limits.push(Limit {
                kind: kind.into(),
                label: limit_label(kind, model),
                percent: item.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0),
                resets_at: item.get("resets_at").and_then(|v| v.as_str()).map(String::from),
                severity: item.get("severity").and_then(|v| v.as_str()).unwrap_or("normal").into(),
                active: item.get("is_active").and_then(|v| v.as_bool()).unwrap_or(false),
            });
        }
    } else {
        for key in ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] {
            if let Some(item) = utilization.get(key).filter(|v| v.is_object()) {
                limits.push(Limit {
                    kind: key.into(),
                    label: limit_label(key, None),
                    percent: item.get("utilization").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    resets_at: item.get("resets_at").and_then(|v| v.as_str()).map(String::from),
                    severity: "normal".into(),
                    active: false,
                });
            }
        }
    }
    (!limits.is_empty()).then_some(Usage { fetched_at, live, limits })
}

fn usage_for(record: &AccountRecord, claude_json_value: Option<&Value>) -> Option<Usage> {
    let cached = claude_json_value.and_then(|j| j.get("cachedUsageUtilization")).and_then(|c| {
        let fetched = c.get("fetchedAtMs").and_then(|v| v.as_u64()).unwrap_or(0);
        parse_usage(c.get("utilization")?, fetched, false)
    });
    let live = read_json(&data_dir().join("usage").join(format!("{}.json", record.id))).and_then(|c| {
        let fetched = c.get("fetchedAtMs").and_then(|v| v.as_u64()).unwrap_or(0);
        parse_usage(c.get("utilization")?, fetched, true)
    });
    match (cached, live) {
        (Some(a), Some(b)) => Some(if b.fetched_at > a.fetched_at { b } else { a }),
        (a, b) => a.or(b),
    }
}

fn plan_name(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let tier = tier.unwrap_or("");
    if tier.contains("max_20x") {
        return Some("Max 20×".into());
    }
    if tier.contains("max_5x") {
        return Some("Max 5×".into());
    }
    subscription.filter(|s| !s.is_empty()).map(|s| {
        let mut chars = s.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        }
    })
}

fn view(record: &AccountRecord, default_id: &str) -> AccountView {
    let dir = config_dir(record);
    let credentials = read_json(&dir.join(".credentials.json"));
    let oauth = credentials.as_ref().and_then(|c| c.get("claudeAiOauth"));
    let profile_json = read_json(&claude_json(record));
    let profile = profile_json.as_ref().and_then(|j| j.get("oauthAccount"));
    let text = |value: Option<&Value>, key: &str| value.and_then(|v| v.get(key)).and_then(|v| v.as_str()).map(String::from);
    let logged_in = oauth
        .and_then(|o| o.get("refreshToken").or_else(|| o.get("accessToken")))
        .and_then(|v| v.as_str())
        .is_some_and(|t| !t.is_empty());
    let shared = record.config_dir.is_none() || SHARED_DIRS.iter().all(|name| is_link(&dir.join(name)));
    AccountView {
        id: record.id.clone(),
        label: record.label.clone(),
        color: record.color.clone(),
        config_dir: path_string(&dir),
        main: record.id == MAIN_ID,
        default: record.id == default_id,
        logged_in,
        email: text(profile, "emailAddress"),
        organization: text(profile, "organizationName"),
        plan: plan_name(
            oauth.and_then(|o| o.get("subscriptionType")).and_then(|v| v.as_str()),
            oauth.and_then(|o| o.get("rateLimitTier")).and_then(|v| v.as_str()),
        ),
        token_expires_at: oauth.and_then(|o| o.get("expiresAt")).and_then(|v| v.as_u64()),
        usage: if logged_in { usage_for(record, profile_json.as_ref()) } else { None },
        shared,
    }
}

fn ensure_shared(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(err)?;
    let main = main_claude_dir();
    for name in SHARED_DIRS {
        let target = main.join(name);
        let link = dir.join(name);
        if link.exists() || is_link(&link) {
            continue;
        }
        fs::create_dir_all(&target).map_err(err)?;
        make_junction(&link, &target)?;
    }
    for name in COPIED_FILES {
        let source = main.join(name);
        let destination = dir.join(name);
        if source.is_file() && !destination.exists() {
            fs::copy(&source, &destination).map_err(err)?;
        }
    }
    Ok(())
}

pub fn sync_claude_md() {
    let Ok(content) = fs::read(main_claude_dir().join("CLAUDE.md")) else { return };
    for record in all_records() {
        let Some(dir) = record.config_dir.as_ref().map(PathBuf::from) else { continue };
        let destination = dir.join("CLAUDE.md");
        if fs::read(&destination).ok().as_deref() != Some(content.as_slice()) {
            let _ = fs::write(&destination, &content);
        }
    }
}

pub fn all_settings_files() -> Vec<PathBuf> {
    all_records().iter().map(|r| config_dir(r).join("settings.json")).collect()
}

#[tauri::command]
pub async fn accounts_list() -> Result<Vec<AccountView>, String> {
    blocking(|| {
        let file = load();
        let default_id = file.default_id.clone().unwrap_or_else(|| MAIN_ID.into());
        Ok(file.accounts.iter().map(|r| view(r, &default_id)).collect())
    })
    .await
}

#[tauri::command]
pub async fn accounts_add(label: String) -> Result<String, String> {
    blocking(move || {
        let mut file = load();
        let clean = label.trim();
        if clean.is_empty() {
            return Err("Дай акаунту назву".into());
        }
        let slug: String = clean
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let id = format!("{}-{:x}", if slug.is_empty() { "account" } else { &slug }, now_ms() % 0xffffff);
        let dir = data_dir().join("accounts").join(&id);
        ensure_shared(&dir)?;
        let color = PALETTE[file.accounts.len() % PALETTE.len()].to_string();
        file.accounts.push(AccountRecord { id: id.clone(), label: clean.into(), color, config_dir: Some(path_string(&dir)) });
        save(&file)?;
        Ok(id)
    })
    .await
}

#[tauri::command]
pub fn accounts_update(id: String, label: Option<String>, color: Option<String>) -> Result<(), String> {
    let mut file = load();
    let record = file.accounts.iter_mut().find(|a| a.id == id).ok_or("Акаунт не знайдено")?;
    if let Some(label) = label.filter(|l| !l.trim().is_empty()) {
        record.label = label.trim().into();
    }
    if let Some(color) = color {
        record.color = color;
    }
    save(&file)
}

#[tauri::command]
pub fn accounts_set_default(id: String) -> Result<(), String> {
    let mut file = load();
    if !file.accounts.iter().any(|a| a.id == id) {
        return Err("Акаунт не знайдено".into());
    }
    file.default_id = Some(id);
    save(&file)
}

#[tauri::command]
pub async fn accounts_remove(id: String, delete_data: bool) -> Result<(), String> {
    blocking(move || {
        if id == MAIN_ID {
            return Err("Основний акаунт не можна видалити".into());
        }
        let mut file = load();
        let record = file.accounts.iter().find(|a| a.id == id).cloned().ok_or("Акаунт не знайдено")?;
        file.accounts.retain(|a| a.id != id);
        if file.default_id.as_deref() == Some(id.as_str()) {
            file.default_id = None;
        }
        save(&file)?;
        if delete_data {
            if let Some(dir) = record.config_dir.map(PathBuf::from) {
                for name in SHARED_DIRS {
                    let link = dir.join(name);
                    if is_link(&link) {
                        fs::remove_dir(&link).map_err(err)?;
                    }
                }
                to_recycle_bin(&dir)?;
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn accounts_sync() -> Result<(), String> {
    blocking(|| {
        for record in all_records() {
            if let Some(dir) = record.config_dir.as_ref().map(PathBuf::from) {
                ensure_shared(&dir)?;
            }
        }
        sync_claude_md();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn accounts_refresh_usage(id: String) -> Result<(), String> {
    blocking(move || {
        let record = record(&id).ok_or("Акаунт не знайдено")?;
        let credentials = read_json(&config_dir(&record).join(".credentials.json")).ok_or("Цей акаунт ще не увійшов у Claude")?;
        let token = credentials
            .pointer("/claudeAiOauth/accessToken")
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .ok_or("Немає токена входу")?;
        let expires = credentials.pointer("/claudeAiOauth/expiresAt").and_then(|v| v.as_u64()).unwrap_or(0);
        if expires > 0 && expires < now_ms() {
            return Err("Токен входу прострочений. Запусти будь-яку сесію Claude цього акаунта — він оновиться сам".into());
        }
        let body = powershell(USAGE_SCRIPT, &[("MAVIX_TOKEN", token)]).map_err(|e| format!("Не вдалося отримати ліміти: {e}"))?;
        let value: Value = serde_json::from_str(body.trim_start_matches('\u{feff}')).map_err(|_| "Сервер повернув незрозумілу відповідь".to_string())?;
        if parse_usage(&value, 0, true).is_none() {
            return Err("У відповіді немає даних про ліміти".into());
        }
        write_json(&data_dir().join("usage").join(format!("{id}.json")), &json!({ "fetchedAtMs": now_ms(), "utilization": value }))
    })
    .await
}
