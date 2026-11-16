use crate::locks;
use crate::util::{blocking, err, hidden, mtime_ms, path_string, to_recycle_bin};
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RENAME_TRIES: u32 = 8;
const RENAME_WAIT_MS: u64 = 250;
const LOCKED_ACCESS: i32 = 5;
const LOCKED_SHARING: i32 = 32;
const LOCKED_REGION: i32 = 33;

const HEAVY_DIRS: [&str; 16] = [
    "node_modules", ".git", "target", "dist", ".next", ".svelte-kit", "__pycache__", ".venv", "venv", ".godot",
    ".import", "Library", "obj", ".turbo", ".cache", ".parcel-cache",
];
const MAX_TEXT: u64 = 8 * 1024 * 1024;
const MAX_IMAGE: u64 = 40 * 1024 * 1024;
const MAX_WALK: usize = 40_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
    size: u64,
    modified: u64,
    dim: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    content: String,
    binary: bool,
    too_large: bool,
    size: u64,
}

pub fn is_heavy(name: &str) -> bool {
    HEAVY_DIRS.iter().any(|h| h.eq_ignore_ascii_case(name))
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = fs::read_dir(&path)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            Some(Entry {
                dim: is_heavy(&name) || name.starts_with('.'),
                dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified: mtime_ms(&meta),
                path: path_string(&entry.path()),
                name,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub fn fs_read_text(path: String) -> Result<TextFile, String> {
    let meta = fs::metadata(&path).map_err(err)?;
    let size = meta.len();
    if size > MAX_TEXT {
        return Ok(TextFile { content: String::new(), binary: false, too_large: true, size });
    }
    let mut bytes = Vec::with_capacity(size as usize);
    fs::File::open(&path).map_err(err)?.read_to_end(&mut bytes).map_err(err)?;
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
        return Ok(TextFile { content: String::new(), binary: true, too_large: false, size });
    }
    let text = String::from_utf8_lossy(&bytes);
    let content = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    Ok(TextFile { content, binary: false, too_large: false, size })
}

#[tauri::command]
pub fn fs_write_text(path: String, content: String) -> Result<u64, String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&target, content.as_bytes()).map_err(err)?;
    Ok(fs::metadata(&target).map(|m| mtime_ms(&m)).unwrap_or(0))
}

pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub async fn fs_read_data_url(path: String) -> Result<String, String> {
    blocking(move || {
        let target = PathBuf::from(&path);
        let meta = fs::metadata(&target).map_err(err)?;
        if meta.len() > MAX_IMAGE {
            return Err("Файл завеликий для перегляду".into());
        }
        let bytes = fs::read(&target).map_err(err)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{};base64,{}", mime_for(&target), encoded))
    })
    .await
}

#[tauri::command]
pub fn fs_create_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if target.exists() {
        return Err("Такий файл уже існує".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&target, b"").map_err(err)
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if target.exists() {
        return Err("Така папка вже існує".into());
    }
    fs::create_dir_all(&target).map_err(err)
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    blocking(move || rename_patiently(Path::new(&from), Path::new(&to))).await
}

fn is_locked(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(LOCKED_SHARING | LOCKED_REGION | LOCKED_ACCESS))
}

fn rename_patiently(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() && !path_string(from).eq_ignore_ascii_case(&path_string(to)) {
        return Err("Там уже є файл з такою назвою".into());
    }
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if is_locked(&error) && attempt < RENAME_TRIES => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(RENAME_WAIT_MS));
            }
            Err(error) if is_locked(&error) => return Err(locked_message(from, &error)),
            Err(error) => return Err(err(error)),
        }
    }
}

fn locked_message(path: &Path, error: &std::io::Error) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path_string(path));
    let folder = path.is_dir();
    let holders = locks::holders(path);
    if !holders.is_empty() {
        let (what, it) = if folder { ("папку", "її") } else { ("файл", "його") };
        return format!("Не вдалося перейменувати {what} «{name}»: {it} зараз тримає {}. Закрий цю програму й спробуй ще раз.", holders.join(", "));
    }
    if folder {
        return format!(
            "Не вдалося перейменувати папку «{name}»: її тримає інша програма. Найчастіше це запущений сервер (npm run dev, vite), термінал, відкритий у цій папці, або Провідник. Зупини його й спробуй ще раз."
        );
    }
    if error.raw_os_error() == Some(LOCKED_ACCESS) {
        return format!("Не вдалося перейменувати «{name}»: Windows не дає доступу. Файл зайнятий або лише для читання.");
    }
    format!("Не вдалося перейменувати «{name}»: файл зайнятий іншою програмою. Закрий її й спробуй ще раз.")
}

#[tauri::command]
pub async fn fs_trash(path: String) -> Result<(), String> {
    blocking(move || to_recycle_bin(Path::new(&path))).await
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let mut command = hidden("explorer.exe");
    if target.is_dir() {
        command.arg(&target);
    } else {
        command.arg(format!("/select,{}", target.display()));
    }
    command.spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("Непідтримуване посилання".into());
    }
    hidden("explorer.exe").arg(url).spawn().map(|_| ()).map_err(err)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    if out.len() >= MAX_WALK {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut dirs = Vec::new();
    for entry in read.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !is_heavy(&name) && !kind.is_symlink() {
                dirs.push(entry.path());
            }
        } else if let Ok(relative) = entry.path().strip_prefix(root) {
            out.push(relative.to_string_lossy().replace('\\', "/"));
            if out.len() >= MAX_WALK {
                return;
            }
        }
    }
    for child in dirs {
        walk(root, &child, out);
    }
}

#[tauri::command]
pub async fn fs_walk(root: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let base = PathBuf::from(&root);
        let mut out = Vec::new();
        walk(&base, &base, &mut out);
        Ok(out)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    file: String,
    line: usize,
    text: String,
}

#[tauri::command]
pub async fn fs_search(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    blocking(move || {
        let base = PathBuf::from(&root);
        let needle = query.to_lowercase();
        if needle.trim().is_empty() {
            return Ok(vec![]);
        }
        let mut files = Vec::new();
        walk(&base, &base, &mut files);
        let mut hits = Vec::new();
        for relative in files {
            let full = base.join(&relative);
            let Ok(meta) = fs::metadata(&full) else { continue };
            if meta.len() > 2 * 1024 * 1024 {
                continue;
            }
            let Ok(bytes) = fs::read(&full) else { continue };
            if bytes[..bytes.len().min(4096)].contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    let trimmed: String = line.trim().chars().take(220).collect();
                    hits.push(SearchHit { file: relative.clone(), line: index + 1, text: trimmed });
                    if hits.len() >= 2000 {
                        return Ok(hits);
                    }
                }
            }
        }
        Ok(hits)
    })
    .await
}

fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(".git");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if candidate.is_file() {
            let text = fs::read_to_string(&candidate).ok()?;
            let pointer = text.trim().strip_prefix("gitdir:")?.trim();
            let resolved = PathBuf::from(pointer);
            return Some(if resolved.is_absolute() { resolved } else { dir.join(resolved) });
        }
        current = dir.parent();
    }
    None
}

#[tauri::command]
pub fn git_branch(root: String) -> Option<String> {
    let git = find_git_dir(Path::new(&root))?;
    let head = fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref: refs/heads/") {
        Some(branch) => Some(branch.to_string()),
        None => Some(head.chars().take(7).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::rename_patiently;
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn locked_file_names_its_holder() {
        let dir = std::env::temp_dir().join(format!("mavix-rename-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let from = dir.join("held.txt");
        let to = dir.join("moved.txt");
        std::fs::write(&from, "x").unwrap();
        let held = OpenOptions::new().read(true).share_mode(0).open(&from).unwrap();
        let message = rename_patiently(&from, &to).unwrap_err();
        drop(held);
        assert!(message.contains("тримає"), "{message}");
        rename_patiently(&from, &to).unwrap();
        assert!(to.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
