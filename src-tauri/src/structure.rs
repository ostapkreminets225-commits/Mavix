use crate::files::is_heavy;
use crate::paths::data_dir;
use crate::skills::replace_section;
use crate::util::{blocking, err, path_string, write_atomic};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

const CLAUDE_HEADING: &str = "## Folder structure (Mavix)";
const CLAUDE_RULE: &str = "Keep this layout. Put new files into the matching folder, create a listed folder when it is first needed, and ask before adding a new top-level folder.";
const KNOWN_FILES: [&str; 12] = [
    "makefile", "dockerfile", "license", "readme", "procfile", "gemfile", "rakefile", "jenkinsfile", "codeowners", "changelog", "authors", "vagrantfile",
];
const KNOWN_DOTFILES: [&str; 14] = [
    ".gitignore", ".gitattributes", ".gitmodules", ".env", ".editorconfig", ".prettierrc", ".eslintrc", ".npmrc", ".nvmrc", ".dockerignore", ".babelrc", ".stylelintrc", ".gdignore", ".mcp",
];

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    id: String,
    name: String,
    tree: String,
    #[serde(default)]
    builtin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    path: String,
    name: String,
    dir: bool,
    exists: bool,
    depth: usize,
}

struct Node {
    path: String,
    name: String,
    dir: bool,
    depth: usize,
}

fn builtin(id: &str, name: &str, tree: &str) -> Template {
    Template { id: id.into(), name: name.into(), tree: tree.trim_start_matches('\n').into(), builtin: true }
}

fn defaults() -> Vec<Template> {
    vec![
        builtin("web-react", "Web-застосунок · Vite + React", "\nsrc/\n  app/\n  components/\n  features/\n  hooks/\n  lib/\n  styles/\n  assets/\npublic/\ntests/\ndocs/\n.claude/\n  skills/\nREADME.md\nCLAUDE.md\n"),
        builtin("tauri-rust", "Десктоп · Tauri + Rust", "\nsrc/\n  components/\n  lib/\n  styles/\nsrc-tauri/\n  src/\n  capabilities/\n  icons/\ndocs/\n.claude/\n  skills/\nREADME.md\nCLAUDE.md\n"),
        builtin("godot-game", "Гра · Godot", "\nassets/\n  art/\n  audio/\n  fonts/\nscenes/\n  levels/\n  ui/\nscripts/\n  autoload/\n  entities/\n  systems/\nshaders/\naddons/\ndocs/\nREADME.md\nCLAUDE.md\n"),
        builtin("playable", "Плеєбл · playable ad", "\nsrc/\n  game/\n  scenes/\n  ui/\n  assets/\nbuild/\ntools/\ndocs/\nREADME.md\nCLAUDE.md\n"),
        builtin("python-tool", "Python-інструмент", "\nsrc/\n  app/\ntests/\nscripts/\ndata/\ndocs/\npyproject.toml\nREADME.md\nCLAUDE.md\n"),
        builtin("claude-skill", "Claude-скіл", "\nSKILL.md\nreferences/\nscripts/\nassets/\n"),
    ]
}

fn templates_file() -> PathBuf {
    data_dir().join("structures.json")
}

fn is_prefix_char(ch: char, next: Option<char>) -> bool {
    matches!(ch, ' ' | '\t' | '|' | '`' | '>')
        || ('\u{2500}'..='\u{257f}').contains(&ch)
        || (matches!(ch, '-' | '*' | '+') && matches!(next, Some(' ' | '-' | '>')))
}

fn cut_annotation(text: &str) -> &str {
    let markers = ["  ", " #", " //", " ←", " <-", " — "];
    let end = markers.iter().filter_map(|m| text.find(m)).min().unwrap_or(text.len());
    &text[..end]
}

fn looks_like_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    if KNOWN_FILES.contains(&lower.as_str()) || KNOWN_DOTFILES.contains(&lower.as_str()) {
        return false;
    }
    match lower.strip_prefix('.') {
        Some(rest) => !rest.contains('.'),
        None => !lower.contains('.'),
    }
}

fn safe_relative(path: &str) -> bool {
    let candidate = Path::new(path);
    !candidate.is_absolute() && candidate.components().all(|c| matches!(c, Component::Normal(_)))
}

fn parse_tree(text: &str) -> Result<Vec<Node>, String> {
    let mut rows: Vec<(usize, String, bool)> = Vec::new();
    for raw in text.lines() {
        let chars: Vec<char> = raw.chars().collect();
        let mut column = 0;
        let mut index = 0;
        while index < chars.len() && is_prefix_char(chars[index], chars.get(index + 1).copied()) {
            column += if chars[index] == '\t' { 4 } else { 1 };
            index += 1;
        }
        let rest: String = chars[index..].iter().collect();
        let name = cut_annotation(rest.trim()).trim().trim_matches('`').trim();
        if name.is_empty() || name == "." || name == "./" || name.starts_with('#') {
            continue;
        }
        let explicit_dir = name.ends_with('/') || name.ends_with('\\');
        let clean = name.trim_end_matches(['/', '\\']).replace('\\', "/");
        if clean.is_empty() {
            continue;
        }
        if !safe_relative(&clean) {
            return Err(format!("Шлях «{clean}» виходить за межі проекту"));
        }
        rows.push((column, clean, explicit_dir));
    }
    let mut nodes = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    for (index, (column, name, explicit_dir)) in rows.iter().enumerate() {
        while stack.last().is_some_and(|(c, _)| c >= column) {
            stack.pop();
        }
        let has_children = rows.get(index + 1).is_some_and(|(next, _, _)| next > column);
        let dir = *explicit_dir || has_children || looks_like_dir(name.rsplit('/').next().unwrap_or(name));
        let path = match stack.last() {
            Some((_, parent)) => format!("{parent}/{name}"),
            None => name.clone(),
        };
        nodes.push(Node { depth: stack.len(), name: name.clone(), path: path.clone(), dir });
        if dir {
            stack.push((*column, path));
        }
    }
    Ok(nodes)
}

fn normalized_tree(nodes: &[Node]) -> String {
    nodes
        .iter()
        .map(|n| format!("{}{}{}", "  ".repeat(n.depth), n.name, if n.dir { "/" } else { "" }))
        .collect::<Vec<_>>()
        .join("\n")
}

fn starter_content(root: &Path, relative: &str) -> String {
    let project = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match relative.to_lowercase().as_str() {
        "readme.md" => format!("# {project}\n"),
        _ => String::new(),
    }
}

fn apply(root: &Path, nodes: &[Node]) -> Result<Vec<String>, String> {
    let mut created = Vec::new();
    for node in nodes {
        let target = root.join(&node.path);
        if target.exists() {
            continue;
        }
        if node.dir {
            fs::create_dir_all(&target).map_err(err)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(err)?;
            }
            fs::write(&target, starter_content(root, &node.path)).map_err(err)?;
        }
        created.push(node.path.clone());
    }
    Ok(created)
}

fn capture(root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<String>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| (!e.path().is_dir(), e.file_name().to_string_lossy().to_lowercase()));
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let hidden = name.starts_with('.') && name != ".claude" && name != ".github";
        if path.is_dir() {
            if is_heavy(&name) || hidden {
                continue;
            }
            out.push(format!("{}{}/", "  ".repeat(depth), name));
            if depth + 1 < max_depth {
                capture(root, &path, depth + 1, max_depth, out);
            }
        } else if depth == 0 && !hidden {
            out.push(name);
        }
    }
}

#[tauri::command]
pub fn structure_templates() -> Vec<Template> {
    fs::read_to_string(templates_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Template>>(&t).ok())
        .filter(|list| !list.is_empty())
        .unwrap_or_else(defaults)
}

#[tauri::command]
pub fn structure_save(templates: Vec<Template>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&templates).map_err(err)?;
    write_atomic(&templates_file(), text.as_bytes())
}

#[tauri::command]
pub fn structure_plan(root: String, tree: String) -> Result<Vec<PlanItem>, String> {
    let base = PathBuf::from(&root);
    Ok(parse_tree(&tree)?
        .into_iter()
        .map(|n| PlanItem { exists: base.join(&n.path).exists(), path: n.path, name: n.name, dir: n.dir, depth: n.depth })
        .collect())
}

#[tauri::command]
pub fn structure_apply(root: String, tree: String) -> Result<Vec<String>, String> {
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err("Папки проекту не існує".into());
    }
    apply(&base, &parse_tree(&tree)?)
}

#[tauri::command]
pub async fn structure_capture(root: String, depth: usize) -> Result<String, String> {
    blocking(move || {
        let base = PathBuf::from(&root);
        let mut lines = Vec::new();
        capture(&base, &base, 0, depth.clamp(1, 6), &mut lines);
        Ok(lines.join("\n"))
    })
    .await
}

#[tauri::command]
pub fn structure_write_claude_md(root: String, tree: String) -> Result<String, String> {
    let nodes = parse_tree(&tree)?;
    if nodes.is_empty() {
        return Err("Структура порожня".into());
    }
    let file = PathBuf::from(&root).join("CLAUDE.md");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let section = format!("{CLAUDE_HEADING}\n\n{CLAUDE_RULE}\n\n```text\n{}\n```", normalized_tree(&nodes));
    fs::write(&file, replace_section(&text, CLAUDE_HEADING, &section)).map_err(err)?;
    Ok(path_string(&file))
}

#[tauri::command]
pub fn project_create(parent: String, name: String, tree: Option<String>) -> Result<String, String> {
    let clean = name.trim();
    if clean.is_empty() || clean.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("Неправильна назва проекту".into());
    }
    let dir = PathBuf::from(&parent).join(clean);
    if dir.exists() && fs::read_dir(&dir).map(|mut r| r.next().is_some()).unwrap_or(false) {
        return Err("Така папка вже існує і вона не порожня".into());
    }
    fs::create_dir_all(&dir).map_err(err)?;
    if let Some(tree) = tree.filter(|t| !t.trim().is_empty()) {
        apply(&dir, &parse_tree(&tree)?)?;
    }
    Ok(path_string(&dir))
}
