use crate::accounts;
use crate::paths::{data_dir, main_claude_dir};
use crate::util::{blocking, copy_dir, err, fnv_hex, hidden, move_dir, mtime_ms, now_ms, path_string, read_json, to_recycle_bin, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const ALWAYS_HEADING: &str = "## Always-on skills (Mavix)";
const ALWAYS_INTRO: &str = "Load each of these skills with the Skill tool before starting any task, and follow its rules for the whole session:";
const MAX_COUNTED_FILES: usize = 400;
const SYNCED_DIR: &str = "synced";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    id: String,
    name: String,
    folder: String,
    description: String,
    scope: String,
    project: Option<String>,
    plugin: Option<String>,
    enabled: bool,
    always: bool,
    path: String,
    skill_file: Option<String>,
    issues: Vec<String>,
    files: usize,
    modified: u64,
    created: u64,
    mine: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MineOverrides {
    #[serde(default)]
    mine: Vec<String>,
    #[serde(default)]
    not_mine: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    key: String,
    name: String,
    version: String,
    description: String,
    enabled: bool,
    path: String,
    skills: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsSnapshot {
    skills: Vec<Skill>,
    plugins: Vec<Plugin>,
    restorable: usize,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SavedPlace {
    scope: String,
    project: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedSkill {
    #[serde(flatten)]
    place: SavedPlace,
    folder: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedAlways {
    #[serde(flatten)]
    place: SavedPlace,
    names: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AllOffMemory {
    #[serde(default)]
    skills: Vec<SavedSkill>,
    #[serde(default)]
    always: Vec<SavedAlways>,
    #[serde(default)]
    plugins: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    skills: usize,
    plugins: usize,
    failed: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    markdown: String,
    name: String,
    description: String,
    scope: String,
    project: Option<String>,
    always: bool,
    overwrite: bool,
}

pub struct Frontmatter {
    pub present: bool,
    pub header: Vec<String>,
    pub fields: Vec<(String, String)>,
    pub body: String,
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
    }
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        return v[1..v.len() - 1].replace("\\\"", "\"").replace("\\n", "\n").replace("\\\\", "\\");
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

fn is_indented(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty()
}

fn parse_fields(lines: &[String]) -> Vec<(String, String)> {
    let mut fields = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = &lines[index];
        index += 1;
        if is_indented(line) || line.trim_start().starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim().to_string();
        let raw = line[colon + 1..].trim().to_string();
        let mut continuation: Vec<&str> = Vec::new();
        while index < lines.len() && is_indented(&lines[index]) {
            continuation.push(&lines[index]);
            index += 1;
        }
        let value = if raw.starts_with('>') || raw.starts_with('|') {
            let folded = raw.starts_with('>');
            let parts: Vec<&str> = continuation.iter().map(|l| l.trim()).collect();
            if folded {
                parts.split(|p| p.is_empty()).map(|chunk| chunk.join(" ")).filter(|c| !c.is_empty()).collect::<Vec<_>>().join("\n")
            } else {
                parts.join("\n")
            }
        } else if raw.is_empty() {
            let nested = continuation.iter().any(|l| l.trim().ends_with(':') || l.contains(": ") || l.trim_start().starts_with("- "));
            if nested {
                String::new()
            } else {
                continuation.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
            }
        } else {
            let mut joined = raw.clone();
            for extra in continuation.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                joined.push(' ');
                joined.push_str(extra);
            }
            unquote(&joined)
        };
        fields.push((key, value.trim().to_string()));
    }
    fields
}

pub fn parse_frontmatter(text: &str) -> Frontmatter {
    let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let lines: Vec<String> = normalized.split('\n').map(String::from).collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return Frontmatter { present: false, header: vec![], fields: vec![], body: normalized };
    }
    let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---" || l.trim_end() == "...").map(|p| p + 1) else {
        return Frontmatter { present: false, header: vec![], fields: vec![], body: normalized };
    };
    let header: Vec<String> = lines[1..end].to_vec();
    let fields = parse_fields(&header);
    let body = lines[end + 1..].join("\n");
    Frontmatter { present: true, header, fields, body }
}

fn strip_keys(header: &[String], keys: &[&str]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut skipping = false;
    for line in header {
        if !is_indented(line) {
            let key = line.split(':').next().unwrap_or("").trim();
            skipping = keys.contains(&key);
        }
        if !skipping {
            kept.push(line.clone());
        }
    }
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    kept
}

fn yaml_quote(text: &str) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("\"{}\"", single_line.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn validate(front: &Frontmatter, folder: &str) -> Vec<String> {
    let mut issues = Vec::new();
    if !front.present {
        issues.push("Немає frontmatter із name і description".to_string());
    }
    match front.get("name") {
        None => issues.push("Немає поля name".into()),
        Some(name) => {
            if !valid_name(name) {
                issues.push("Назва має бути з малих латинських літер, цифр і дефісів, до 64 символів".into());
            }
            if name != folder {
                issues.push(format!("Назва «{name}» не збігається з папкою «{folder}»"));
            }
        }
    }
    match front.get("description") {
        None => issues.push("Немає опису — Claude не знатиме, коли вмикати скіл".into()),
        Some(description) if description.chars().count() > 1024 => issues.push("Опис довший за 1024 символи".into()),
        _ => {}
    }
    issues
}

fn find_skill_file(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join("SKILL.md");
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
        p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("skill.md"))
    })
}

fn count_files(dir: &Path, total: &mut usize) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.filter_map(|e| e.ok()) {
        if *total >= MAX_COUNTED_FILES {
            return;
        }
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => count_files(&entry.path(), total),
            Ok(_) => *total += 1,
            Err(_) => {}
        }
    }
}

struct Origin<'a> {
    scope: &'a str,
    project: Option<&'a str>,
    plugin: Option<&'a str>,
    enabled: bool,
}

fn read_skill(dir: &Path, origin: &Origin, always: &HashSet<String>) -> Option<Skill> {
    if !dir.is_dir() {
        return None;
    }
    let folder = dir.file_name()?.to_string_lossy().to_string();
    if folder.starts_with('.') {
        return None;
    }
    let skill_file = find_skill_file(dir);
    let (front, modified) = match &skill_file {
        Some(file) => {
            let bytes = fs::read(file).ok()?;
            let modified = fs::metadata(file).map(|m| mtime_ms(&m)).unwrap_or(0);
            (parse_frontmatter(&String::from_utf8_lossy(&bytes)), modified)
        }
        None => (Frontmatter { present: false, header: vec![], fields: vec![], body: String::new() }, 0),
    };
    let mut issues = if skill_file.is_some() { validate(&front, &folder) } else { vec!["Немає SKILL.md — Claude цей скіл не бачить".into()] };
    if origin.plugin.is_some() {
        issues.retain(|i| !i.starts_with("Назва «") && !i.starts_with("Назва має"));
    }
    let name = front.get("name").unwrap_or(&folder).to_string();
    let mut files = 0;
    count_files(dir, &mut files);
    let created = fs::metadata(dir)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(modified);
    Some(Skill {
        created,
        mine: false,
        id: format!("{}:{}:{}", origin.scope, origin.project.or(origin.plugin).unwrap_or(""), folder),
        always: always.contains(&name) || always.contains(&folder),
        description: front.get("description").unwrap_or("").to_string(),
        scope: origin.scope.into(),
        project: origin.project.map(String::from),
        plugin: origin.plugin.map(String::from),
        enabled: origin.enabled,
        path: path_string(dir),
        skill_file: skill_file.map(|p| path_string(&p)),
        issues,
        files,
        modified,
        name,
        folder,
    })
}

fn user_root() -> PathBuf {
    main_claude_dir().join("skills")
}

fn disabled_root(scope: &str, project: Option<&str>) -> PathBuf {
    let base = data_dir().join("disabled-skills");
    match (scope, project) {
        ("project", Some(root)) => base.join(format!("project-{}", fnv_hex(root))),
        _ => base.join("user"),
    }
}

fn active_root(scope: &str, project: Option<&str>) -> Result<PathBuf, String> {
    match (scope, project) {
        ("project", Some(root)) => Ok(PathBuf::from(root).join(".claude").join("skills")),
        ("project", None) => Err("Не вибрано проект".into()),
        _ => Ok(user_root()),
    }
}

fn claude_md_for(scope: &str, project: Option<&str>) -> PathBuf {
    match (scope, project) {
        ("project", Some(root)) => PathBuf::from(root).join("CLAUDE.md"),
        _ => main_claude_dir().join("CLAUDE.md"),
    }
}

pub fn find_section(text: &str, heading: &str) -> Option<(usize, usize)> {
    let mut offset = 0;
    let mut start = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        match start {
            None if trimmed == heading => start = Some(offset),
            Some(_) if trimmed.starts_with("# ") || trimmed.starts_with("## ") => return start.map(|s| (s, offset)),
            _ => {}
        }
        offset += line.len();
    }
    start.map(|s| (s, text.len()))
}

pub fn replace_section(text: &str, heading: &str, section: &str) -> String {
    let section = section.trim();
    let (before, after) = match find_section(text, heading) {
        Some((start, end)) => (text[..start].trim_end(), text[end..].trim_start()),
        None => (text.trim_end(), ""),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in [before, section, after] {
        if !part.is_empty() {
            parts.push(part);
        }
    }
    let mut joined = parts.join("\n\n");
    if !joined.is_empty() {
        joined.push('\n');
    }
    joined
}

fn always_names(claude_md: &Path) -> Vec<String> {
    let text = fs::read_to_string(claude_md).unwrap_or_default();
    let Some((start, end)) = find_section(&text, ALWAYS_HEADING) else { return vec![] };
    text[start..end]
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("- `")?;
            Some(rest.split('`').next()?.to_string())
        })
        .filter(|name| !name.is_empty())
        .collect()
}

fn set_always(claude_md: &Path, name: &str, on: bool) -> Result<(), String> {
    let mut names = always_names(claude_md);
    let had = names.iter().any(|n| n == name);
    if on == had {
        return Ok(());
    }
    if on {
        names.push(name.to_string());
    } else {
        names.retain(|n| n != name);
    }
    let section = if names.is_empty() {
        String::new()
    } else {
        let bullets = names.iter().map(|n| format!("- `{n}`")).collect::<Vec<_>>().join("\n");
        format!("{ALWAYS_HEADING}\n\n{ALWAYS_INTRO}\n\n{bullets}")
    };
    let text = fs::read_to_string(claude_md).unwrap_or_default();
    let updated = replace_section(&text, ALWAYS_HEADING, &section);
    if let Some(parent) = claude_md.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(claude_md, updated).map_err(err)
}

fn scan_root(root: &Path, origin: &Origin, always: &HashSet<String>, out: &mut Vec<Skill>) {
    let Ok(read) = fs::read_dir(root) else { return };
    let mut dirs: Vec<PathBuf> = read.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for dir in dirs {
        if origin.scope == "user" && dir.file_name().is_some_and(|n| n == SYNCED_DIR) && find_skill_file(&dir).is_none() {
            continue;
        }
        if let Some(skill) = read_skill(&dir, origin, always) {
            out.push(skill);
        }
    }
}

fn scan_synced(always: &HashSet<String>, out: &mut Vec<Skill>) {
    let Ok(groups) = fs::read_dir(user_root().join(SYNCED_DIR)) else { return };
    let mut seen: HashSet<String> = HashSet::new();
    let origin = Origin { scope: "synced", project: None, plugin: Some("claude.ai"), enabled: true };
    for group in groups.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(read) = fs::read_dir(&group) else { continue };
        let mut dirs: Vec<PathBuf> = read.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            if find_skill_file(&dir).is_none() {
                continue;
            }
            if let Some(mut skill) = read_skill(&dir, &origin, always) {
                if seen.insert(skill.name.clone()) {
                    skill.id = format!("synced:{}", skill.name);
                    out.push(skill);
                }
            }
        }
    }
}

fn plugin_list() -> Vec<(Plugin, PathBuf)> {
    let Some(installed) = read_json(&main_claude_dir().join("plugins").join("installed_plugins.json")) else { return vec![] };
    let enabled_map = read_json(&main_claude_dir().join("settings.json")).and_then(|s| s.get("enabledPlugins").cloned());
    let Some(plugins) = installed.get("plugins").and_then(|p| p.as_object()) else { return vec![] };
    let mut list = Vec::new();
    for (key, entries) in plugins {
        let Some(entry) = entries.as_array().and_then(|a| a.first()) else { continue };
        let Some(install) = entry.get("installPath").and_then(|v| v.as_str()).map(PathBuf::from) else { continue };
        let manifest = read_json(&install.join(".claude-plugin").join("plugin.json"));
        let field = |name: &str| manifest.as_ref().and_then(|m| m.get(name)).and_then(|v| v.as_str()).map(String::from);
        let skills_dir = install.join("skills");
        let skills = fs::read_dir(&skills_dir).map(|r| r.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).count()).unwrap_or(0);
        list.push((
            Plugin {
                key: key.clone(),
                name: field("name").unwrap_or_else(|| key.split('@').next().unwrap_or(key).to_string()),
                version: entry.get("version").and_then(|v| v.as_str()).map(String::from).or_else(|| field("version")).unwrap_or_default(),
                description: field("description").unwrap_or_default(),
                enabled: enabled_map.as_ref().and_then(|m| m.get(key)).and_then(|v| v.as_bool()).unwrap_or(false),
                path: path_string(&install),
                skills,
            },
            skills_dir,
        ));
    }
    list
}

fn snapshot(projects: &[String]) -> SkillsSnapshot {
    let mut skills = Vec::new();
    let user_always: HashSet<String> = always_names(&claude_md_for("user", None)).into_iter().collect();
    scan_root(&user_root(), &Origin { scope: "user", project: None, plugin: None, enabled: true }, &user_always, &mut skills);
    scan_root(&disabled_root("user", None), &Origin { scope: "user", project: None, plugin: None, enabled: false }, &user_always, &mut skills);
    scan_synced(&user_always, &mut skills);
    for root in projects {
        let always: HashSet<String> = always_names(&claude_md_for("project", Some(root))).into_iter().collect();
        if let Ok(active) = active_root("project", Some(root)) {
            scan_root(&active, &Origin { scope: "project", project: Some(root), plugin: None, enabled: true }, &always, &mut skills);
        }
        scan_root(&disabled_root("project", Some(root)), &Origin { scope: "project", project: Some(root), plugin: None, enabled: false }, &always, &mut skills);
    }
    let mut plugins = Vec::new();
    for (plugin, dir) in plugin_list() {
        let origin = Origin { scope: "plugin", project: None, plugin: Some(&plugin.name), enabled: plugin.enabled };
        scan_root(&dir, &origin, &user_always, &mut skills);
        plugins.push(plugin);
    }
    mark_mine(&mut skills);
    let memory = load_all_off();
    SkillsSnapshot { skills, plugins, restorable: memory.skills.len() + memory.plugins.len() }
}

fn all_off_file() -> PathBuf {
    data_dir().join("skills-all-off.json")
}

fn load_all_off() -> AllOffMemory {
    read_json(&all_off_file()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn places(projects: &[String]) -> Vec<SavedPlace> {
    let mut list = vec![SavedPlace { scope: "user".into(), project: None }];
    for root in projects {
        let place = SavedPlace { scope: "project".into(), project: Some(root.clone()) };
        if !list.contains(&place) {
            list.push(place);
        }
    }
    list
}

fn movable_folders(root: &Path, scope: &str) -> Vec<String> {
    let Ok(read) = fs::read_dir(root) else { return vec![] };
    let mut folders: Vec<String> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| !name.starts_with('.') && !(scope == "user" && name == SYNCED_DIR))
        .collect();
    folders.sort();
    folders
}

fn move_skill(from_root: &Path, to_root: &Path, folder: &str, result: &mut BulkResult) -> bool {
    let source = from_root.join(folder);
    let destination = to_root.join(folder);
    if destination.exists() {
        result.failed.push(format!("{folder}: там уже є скіл з такою назвою"));
        return false;
    }
    match move_dir(&source, &destination) {
        Ok(()) => {
            result.skills += 1;
            true
        }
        Err(error) => {
            result.failed.push(format!("{folder}: {error}"));
            false
        }
    }
}

fn clear_always(claude_md: &Path) -> Result<Vec<String>, String> {
    let names = always_names(claude_md);
    if !names.is_empty() {
        let text = fs::read_to_string(claude_md).unwrap_or_default();
        fs::write(claude_md, replace_section(&text, ALWAYS_HEADING, "")).map_err(err)?;
    }
    Ok(names)
}

fn set_plugin_everywhere(key: &str, enabled: bool) -> Result<(), String> {
    for file in accounts::all_settings_files() {
        if !file.exists() && file != main_claude_dir().join("settings.json") {
            continue;
        }
        let mut settings = read_json(&file).unwrap_or_else(|| Value::Object(Map::new()));
        let Some(object) = settings.as_object_mut() else { continue };
        let plugins = object.entry("enabledPlugins").or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = plugins.as_object_mut() {
            map.insert(key.to_string(), Value::Bool(enabled));
        }
        write_json(&file, &settings)?;
    }
    Ok(())
}

fn place_exists(place: &SavedPlace) -> bool {
    place.project.as_deref().map_or(true, |root| Path::new(root).is_dir())
}

fn remember_always(memory: &mut AllOffMemory, place: &SavedPlace, names: Vec<String>) {
    match memory.always.iter_mut().find(|a| &a.place == place) {
        Some(saved) => {
            for name in names {
                if !saved.names.contains(&name) {
                    saved.names.push(name);
                }
            }
        }
        None => memory.always.push(SavedAlways { place: place.clone(), names }),
    }
}

fn save_all_off(memory: &AllOffMemory) -> Result<(), String> {
    if memory.skills.is_empty() && memory.always.is_empty() && memory.plugins.is_empty() {
        let _ = fs::remove_file(all_off_file());
        return Ok(());
    }
    write_json(&all_off_file(), &serde_json::to_value(memory).map_err(err)?)
}

fn disable_all(projects: &[String]) -> Result<BulkResult, String> {
    let mut memory = load_all_off();
    let mut result = BulkResult::default();
    for place in places(projects).into_iter().filter(place_exists) {
        let project = place.project.as_deref();
        let Ok(active) = active_root(&place.scope, project) else { continue };
        let disabled = disabled_root(&place.scope, project);
        match clear_always(&claude_md_for(&place.scope, project)) {
            Ok(names) if !names.is_empty() => remember_always(&mut memory, &place, names),
            Ok(_) => {}
            Err(error) => result.failed.push(format!("CLAUDE.md: {error}")),
        }
        for folder in movable_folders(&active, &place.scope) {
            if move_skill(&active, &disabled, &folder, &mut result) && !memory.skills.iter().any(|s| s.place == place && s.folder == folder) {
                memory.skills.push(SavedSkill { place: place.clone(), folder });
            }
        }
    }
    for (plugin, _) in plugin_list() {
        if !plugin.enabled || plugin.skills == 0 {
            continue;
        }
        match set_plugin_everywhere(&plugin.key, false) {
            Ok(()) => {
                result.plugins += 1;
                if !memory.plugins.contains(&plugin.key) {
                    memory.plugins.push(plugin.key);
                }
            }
            Err(error) => result.failed.push(format!("{}: {error}", plugin.name)),
        }
    }
    let saved = save_all_off(&memory);
    accounts::sync_claude_md();
    saved.map(|_| result)
}

fn restore_remembered(memory: AllOffMemory, result: &mut BulkResult) -> AllOffMemory {
    let mut left = AllOffMemory::default();
    for saved in memory.skills {
        if !place_exists(&saved.place) {
            continue;
        }
        let project = saved.place.project.as_deref();
        let Ok(active) = active_root(&saved.place.scope, project) else { continue };
        let disabled = disabled_root(&saved.place.scope, project);
        if disabled.join(&saved.folder).is_dir() && !move_skill(&disabled, &active, &saved.folder, result) {
            left.skills.push(saved);
        }
    }
    for saved in memory.always.into_iter().filter(|a| place_exists(&a.place)) {
        let claude_md = claude_md_for(&saved.place.scope, saved.place.project.as_deref());
        let mut missed = Vec::new();
        for name in saved.names {
            if let Err(error) = set_always(&claude_md, &name, true) {
                result.failed.push(format!("{name}: {error}"));
                missed.push(name);
            }
        }
        if !missed.is_empty() {
            left.always.push(SavedAlways { place: saved.place, names: missed });
        }
    }
    for key in memory.plugins {
        match set_plugin_everywhere(&key, true) {
            Ok(()) => result.plugins += 1,
            Err(error) => {
                result.failed.push(format!("{key}: {error}"));
                left.plugins.push(key);
            }
        }
    }
    left
}

fn enable_all(projects: &[String]) -> Result<BulkResult, String> {
    let memory = load_all_off();
    let mut result = BulkResult::default();
    let remembered = !memory.skills.is_empty() || !memory.plugins.is_empty() || !memory.always.is_empty();
    let left = if remembered {
        restore_remembered(memory, &mut result)
    } else {
        for place in places(projects).into_iter().filter(place_exists) {
            let project = place.project.as_deref();
            let Ok(active) = active_root(&place.scope, project) else { continue };
            let disabled = disabled_root(&place.scope, project);
            for folder in movable_folders(&disabled, &place.scope) {
                move_skill(&disabled, &active, &folder, &mut result);
            }
        }
        AllOffMemory::default()
    };
    let saved = save_all_off(&left);
    accounts::sync_claude_md();
    saved.map(|_| result)
}

#[tauri::command]
pub async fn skills_disable_all(projects: Vec<String>) -> Result<BulkResult, String> {
    blocking(move || disable_all(&projects)).await
}

#[tauri::command]
pub async fn skills_enable_all(projects: Vec<String>) -> Result<BulkResult, String> {
    blocking(move || enable_all(&projects)).await
}

const PACK_GAP_MS: u64 = 15 * 60 * 1000;
const PACK_MIN_SIZE: usize = 10;

fn mine_file() -> PathBuf {
    data_dir().join("skills-mine.json")
}

fn load_mine() -> MineOverrides {
    read_json(&mine_file()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save_mine(overrides: &MineOverrides) -> Result<(), String> {
    write_json(&mine_file(), &serde_json::to_value(overrides).map_err(err)?)
}

fn remember_mine(name: &str, mine: bool) -> Result<(), String> {
    let mut overrides = load_mine();
    overrides.mine.retain(|n| n != name);
    overrides.not_mine.retain(|n| n != name);
    if mine {
        overrides.mine.push(name.to_string());
    } else {
        overrides.not_mine.push(name.to_string());
    }
    save_mine(&overrides)
}

fn mark_mine(skills: &mut [Skill]) {
    let overrides = load_mine();
    let mut own: Vec<usize> = (0..skills.len()).filter(|&i| skills[i].scope == "user" || skills[i].scope == "project").collect();
    own.sort_by_key(|&i| skills[i].created);
    let mut group: Vec<usize> = Vec::new();
    let mut previous = 0u64;
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for index in own {
        let created = skills[index].created;
        if !group.is_empty() && created.saturating_sub(previous) > PACK_GAP_MS {
            groups.push(std::mem::take(&mut group));
        }
        group.push(index);
        previous = created;
    }
    if !group.is_empty() {
        groups.push(group);
    }
    for group in groups {
        let individually_added = group.len() < PACK_MIN_SIZE;
        for index in group {
            let skill = &mut skills[index];
            skill.mine = if overrides.mine.iter().any(|n| n == &skill.name) {
                true
            } else if overrides.not_mine.iter().any(|n| n == &skill.name) {
                false
            } else {
                individually_added
            };
        }
    }
}

#[tauri::command]
pub async fn skills_set_mine(name: String, mine: bool) -> Result<(), String> {
    blocking(move || remember_mine(&name, mine)).await
}

fn find_skill_dirs(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if find_skill_file(root).is_some() {
        out.push(root.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(read) = fs::read_dir(root) else { return };
    for entry in read.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() && !entry.file_name().to_string_lossy().starts_with("__MACOSX") {
            find_skill_dirs(&path, depth - 1, out);
        }
    }
}

fn ascii_slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn after_user_change(scope: &str) {
    if scope != "project" {
        accounts::sync_claude_md();
    }
}

#[tauri::command]
pub async fn skills_list(projects: Vec<String>) -> Result<SkillsSnapshot, String> {
    blocking(move || {
        let snap = snapshot(&projects);
        refresh_projects(&snap.skills, &projects);
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn skills_set_enabled(path: String, scope: String, project: Option<String>, enabled: bool) -> Result<String, String> {
    blocking(move || {
        let source = PathBuf::from(&path);
        let folder = source.file_name().ok_or("Неправильний шлях скіла")?.to_string_lossy().to_string();
        let active = active_root(&scope, project.as_deref())?;
        let disabled = disabled_root(&scope, project.as_deref());
        let (expected_parent, destination_root) = if enabled { (&disabled, &active) } else { (&active, &disabled) };
        if source.parent() != Some(expected_parent.as_path()) {
            return Err("Скіл уже в цьому стані".into());
        }
        let destination = destination_root.join(&folder);
        if destination.exists() {
            return Err(format!("Там уже є скіл «{folder}»"));
        }
        if !enabled {
            let name = find_skill_file(&source)
                .and_then(|f| fs::read_to_string(f).ok())
                .and_then(|t| parse_frontmatter(&t).get("name").map(String::from))
                .unwrap_or_else(|| folder.clone());
            set_always(&claude_md_for(&scope, project.as_deref()), &name, false)?;
            after_user_change(&scope);
        }
        move_dir(&source, &destination)?;
        Ok(path_string(&destination))
    })
    .await
}

#[tauri::command]
pub async fn skills_set_always(name: String, scope: String, project: Option<String>, always: bool) -> Result<(), String> {
    blocking(move || {
        set_always(&claude_md_for(&scope, project.as_deref()), &name, always)?;
        after_user_change(&scope);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn skills_create(draft: SkillDraft) -> Result<Skill, String> {
    blocking(move || {
        let name = draft.name.trim().to_string();
        if !valid_name(&name) {
            return Err("Назва скіла: малі латинські літери, цифри й дефіси, до 64 символів".into());
        }
        let description = draft.description.trim().to_string();
        if description.is_empty() {
            return Err("Опиши, коли Claude має вмикати цей скіл".into());
        }
        if description.chars().count() > 1024 {
            return Err("Опис має бути до 1024 символів".into());
        }
        let front = parse_frontmatter(&draft.markdown);
        let body = front.body.trim().to_string();
        if body.is_empty() {
            return Err("Встав текст правил скіла".into());
        }
        let extra = strip_keys(&front.header, &["name", "description"]);
        let mut header = vec![format!("name: {name}"), format!("description: {}", yaml_quote(&description))];
        header.extend(extra);
        let content = format!("---\n{}\n---\n\n{}\n", header.join("\n"), body);

        let root = active_root(&draft.scope, draft.project.as_deref())?;
        let dir = root.join(&name);
        if dir.exists() && !draft.overwrite {
            return Err(format!("Скіл «{name}» уже існує"));
        }
        fs::create_dir_all(&dir).map_err(err)?;
        fs::write(dir.join("SKILL.md"), content).map_err(err)?;
        let _ = remember_mine(&name, true);
        if draft.always {
            set_always(&claude_md_for(&draft.scope, draft.project.as_deref()), &name, true)?;
        }
        after_user_change(&draft.scope);
        let always: HashSet<String> = always_names(&claude_md_for(&draft.scope, draft.project.as_deref())).into_iter().collect();
        let origin = Origin { scope: if draft.scope == "project" { "project" } else { "user" }, project: draft.project.as_deref(), plugin: None, enabled: true };
        read_skill(&dir, &origin, &always)
            .map(|mut skill| {
                skill.mine = true;
                skill
            })
            .ok_or_else(|| "Скіл записано, але його не вдалося прочитати".to_string())
    })
    .await
}

#[tauri::command]
pub async fn skills_import(path: String, scope: String, project: Option<String>, overwrite: bool) -> Result<Vec<Skill>, String> {
    blocking(move || {
        let source = PathBuf::from(&path);
        let mut temp: Option<PathBuf> = None;
        let search_root = if source.is_dir() {
            source.clone()
        } else {
            let extension = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if extension != "zip" && extension != "skill" {
                return Err("Підтримуються папки, .zip і .skill. Markdown встав у форму «Новий скіл»".into());
            }
            let dir = data_dir().join("tmp").join(format!("import-{}", now_ms()));
            fs::create_dir_all(&dir).map_err(err)?;
            let tar = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows")).join("System32").join("tar.exe");
            let status = hidden(&tar.to_string_lossy()).arg("-xf").arg(&source).arg("-C").arg(&dir).status().map_err(err)?;
            if !status.success() {
                let _ = fs::remove_dir_all(&dir);
                return Err("Не вдалося розпакувати архів".into());
            }
            temp = Some(dir.clone());
            dir
        };
        let mut found = Vec::new();
        find_skill_dirs(&search_root, 3, &mut found);
        let result = (|| {
            if found.is_empty() {
                return Err("У цьому місці немає жодного SKILL.md".to_string());
            }
            let root = active_root(&scope, project.as_deref())?;
            fs::create_dir_all(&root).map_err(err)?;
            let mut installed_dirs = Vec::new();
            for dir in &found {
                let front = find_skill_file(dir).and_then(|f| fs::read_to_string(f).ok()).map(|t| parse_frontmatter(&t));
                let folder_name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let candidate = front.as_ref().and_then(|f| f.get("name").map(String::from)).unwrap_or_else(|| folder_name.clone());
                let name = if valid_name(&candidate) { candidate } else { ascii_slug(&folder_name) };
                let name = if name.is_empty() { format!("skill-{}", now_ms()) } else { name };
                let destination = root.join(&name);
                if destination.exists() {
                    if !overwrite {
                        return Err(format!("Скіл «{name}» уже встановлено"));
                    }
                    to_recycle_bin(&destination)?;
                }
                copy_dir(dir, &destination).map_err(err)?;
                installed_dirs.push(destination);
            }
            Ok(installed_dirs)
        })();
        if let Some(dir) = temp {
            let _ = fs::remove_dir_all(dir);
        }
        let installed_dirs = result?;
        after_user_change(&scope);
        let always: HashSet<String> = always_names(&claude_md_for(&scope, project.as_deref())).into_iter().collect();
        let origin = Origin { scope: if scope == "project" { "project" } else { "user" }, project: project.as_deref(), plugin: None, enabled: true };
        Ok(installed_dirs.iter().filter_map(|d| read_skill(d, &origin, &always)).collect())
    })
    .await
}

#[tauri::command]
pub async fn skills_delete(path: String, name: String, scope: String, project: Option<String>) -> Result<(), String> {
    blocking(move || {
        let target = PathBuf::from(&path);
        let allowed = [active_root(&scope, project.as_deref()).ok(), Some(disabled_root(&scope, project.as_deref()))];
        if !allowed.iter().flatten().any(|root| target.parent() == Some(root.as_path())) {
            return Err("Цей скіл не можна видалити звідси".into());
        }
        set_always(&claude_md_for(&scope, project.as_deref()), &name, false)?;
        to_recycle_bin(&target)?;
        after_user_change(&scope);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn plugins_set_enabled(key: String, enabled: bool) -> Result<(), String> {
    blocking(move || set_plugin_everywhere(&key, enabled)).await
}

#[tauri::command]
pub fn skill_files(path: String) -> Vec<String> {
    fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(read) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = read.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if out.len() >= 300 {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                collect(root, &path, out);
            } else if let Ok(relative) = path.strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let root = PathBuf::from(&path);
    let mut out = Vec::new();
    collect(&root, &root, &mut out);
    out
}

const OVERRIDE_OFF: &str = "off";
const LOCAL_SETTINGS: &str = "settings.local.json";
const EXCLUDE_LINE: &str = ".claude/settings.local.json";

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct ProjectEntry {
    root: String,
    on: bool,
    selected: Vec<String>,
    managed: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct ProjectFile {
    projects: Vec<ProjectEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkills {
    root: String,
    on: bool,
    selected: Vec<String>,
    hidden: usize,
}

fn project_file() -> PathBuf {
    data_dir().join("project-skills.json")
}

fn load_projects() -> ProjectFile {
    read_json(&project_file()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save_projects(file: &ProjectFile) -> Result<(), String> {
    write_json(&project_file(), &serde_json::to_value(file).map_err(err)?)
}

fn same_root(a: &str, b: &str) -> bool {
    let clean = |p: &str| p.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    clean(a) == clean(b)
}

fn skill_keys(skill: &Skill) -> Vec<String> {
    match skill.scope.as_str() {
        "plugin" => vec![format!("{}:{}", skill.plugin.as_deref().unwrap_or(""), skill.name)],
        "synced" => {
            let group = Path::new(&skill.path).parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if group.is_empty() { vec![skill.name.clone()] } else { vec![format!("{group}:{}", skill.name), skill.name.clone()] }
        }
        _ => vec![skill.name.clone()],
    }
}

fn keys_for(skills: &[Skill], root: &str) -> Vec<Vec<String>> {
    skills
        .iter()
        .filter(|s| s.enabled && (s.scope != "project" || s.project.as_deref().is_some_and(|p| same_root(p, root))))
        .map(skill_keys)
        .collect()
}

fn project_skill_keys(root: &str) -> Vec<Vec<String>> {
    keys_for(&snapshot(&[root.to_string()]).skills, root)
}

fn read_settings(file: &Path) -> Result<Value, String> {
    if !file.is_file() {
        return Ok(Value::Object(Map::new()));
    }
    let text = fs::read_to_string(file).map_err(err)?;
    let clean = text.trim_start_matches('\u{feff}');
    if clean.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(clean).map_err(|e| format!("{} має помилку: {e}", path_string(file)))
}

fn exclude_locally(root: &Path) {
    let info = root.join(".git").join("info");
    if !info.is_dir() {
        return;
    }
    let exclude = info.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == EXCLUDE_LINE) {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(EXCLUDE_LINE);
    next.push('\n');
    let _ = fs::write(&exclude, next);
}

fn apply_project(entry: &mut ProjectEntry, skills: &[Vec<String>]) -> Result<usize, String> {
    let root = Path::new(&entry.root);
    let file = root.join(".claude").join(LOCAL_SETTINGS);
    let mut settings = read_settings(&file)?;
    let before = settings.clone();
    let object = settings.as_object_mut().ok_or("settings.local.json не є об'єктом")?;
    let overrides = object.entry("skillOverrides").or_insert_with(|| Value::Object(Map::new()));
    let overrides = overrides.as_object_mut().ok_or("поле skillOverrides не є об'єктом")?;
    for key in &entry.managed {
        if overrides.get(key).and_then(Value::as_str) == Some(OVERRIDE_OFF) {
            overrides.remove(key);
        }
    }
    let selected: HashSet<String> = entry.selected.iter().map(|s| s.to_lowercase()).collect();
    let mut managed = Vec::new();
    let mut hidden = 0;
    if entry.on {
        for keys in skills {
            let Some(primary) = keys.first() else { continue };
            if selected.contains(&primary.to_lowercase()) {
                continue;
            }
            hidden += 1;
            for key in keys {
                if overrides.contains_key(key) {
                    continue;
                }
                overrides.insert(key.clone(), Value::String(OVERRIDE_OFF.into()));
                managed.push(key.clone());
            }
        }
    }
    if overrides.is_empty() {
        object.remove("skillOverrides");
    }
    entry.managed = managed;
    if settings != before {
        if !file.is_file() && settings.as_object().is_some_and(|o| o.is_empty()) {
            return Ok(hidden);
        }
        fs::create_dir_all(root.join(".claude")).map_err(err)?;
        write_json(&file, &settings)?;
        exclude_locally(root);
    }
    Ok(hidden)
}

fn project_view(entry: &ProjectEntry, hidden: usize) -> ProjectSkills {
    ProjectSkills { root: entry.root.clone(), on: entry.on, selected: entry.selected.clone(), hidden }
}

fn refresh_projects(skills: &[Skill], projects: &[String]) {
    let mut file = load_projects();
    let mut changed = false;
    for entry in file.projects.iter_mut().filter(|e| e.on && projects.iter().any(|p| same_root(p, &e.root))) {
        if !Path::new(&entry.root).is_dir() {
            continue;
        }
        let before = entry.managed.clone();
        if apply_project(entry, &keys_for(skills, &entry.root)).is_ok() && entry.managed != before {
            changed = true;
        }
    }
    if changed {
        let _ = save_projects(&file);
    }
}

#[tauri::command]
pub async fn skills_project(root: String) -> Result<ProjectSkills, String> {
    blocking(move || {
        let file = load_projects();
        let entry = file.projects.into_iter().find(|e| same_root(&e.root, &root)).unwrap_or(ProjectEntry { root: root.clone(), ..Default::default() });
        let skills = project_skill_keys(&root);
        let selected: HashSet<String> = entry.selected.iter().map(|s| s.to_lowercase()).collect();
        let hidden = if entry.on { skills.iter().filter(|k| k.first().is_some_and(|p| !selected.contains(&p.to_lowercase()))).count() } else { 0 };
        Ok(project_view(&entry, hidden))
    })
    .await
}

#[tauri::command]
pub async fn skills_project_set(root: String, on: bool, selected: Vec<String>) -> Result<ProjectSkills, String> {
    blocking(move || {
        if !Path::new(&root).is_dir() {
            return Err("Папки проекту не існує".into());
        }
        let mut file = load_projects();
        let index = match file.projects.iter().position(|e| same_root(&e.root, &root)) {
            Some(index) => index,
            None => {
                file.projects.push(ProjectEntry { root: root.clone(), ..Default::default() });
                file.projects.len() - 1
            }
        };
        let entry = &mut file.projects[index];
        entry.on = on;
        entry.selected = selected;
        let hidden = apply_project(entry, &project_skill_keys(&root))?;
        let view = project_view(entry, hidden);
        save_projects(&file)?;
        Ok(view)
    })
    .await
}
