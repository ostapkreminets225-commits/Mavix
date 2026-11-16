use crate::files::mime_for;
use crate::paths::{data_dir, home, main_claude_dir};
use crate::pty::{shells, ShellInfo};
use crate::util::{blocking, err, find_in_path, path_string, read_json};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    home: String,
    data_dir: String,
    claude_dir: String,
    claude_path: Option<String>,
    shells: Vec<ShellInfo>,
    terminal_image: Option<String>,
    terminal_image_opacity: Option<f64>,
    terminal_scheme: Option<Value>,
}

fn windows_terminal_settings() -> Option<Value> {
    let packages = dirs::data_local_dir()?.join("Packages");
    let entries = std::fs::read_dir(packages).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("Microsoft.WindowsTerminal") {
            if let Some(value) = read_json(&entry.path().join("LocalState").join("settings.json")) {
                return Some(value);
            }
        }
    }
    None
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    let terminal = windows_terminal_settings();
    let defaults = terminal.as_ref().and_then(|t| t.pointer("/profiles/defaults").cloned());
    let image = defaults
        .as_ref()
        .and_then(|d| d.get("backgroundImage"))
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| path_string(&p));
    let opacity = defaults.as_ref().and_then(|d| d.get("backgroundImageOpacity")).and_then(|v| v.as_f64());
    let scheme_name = defaults.as_ref().and_then(|d| d.get("colorScheme")).and_then(|v| v.as_str()).map(String::from);
    let scheme = match (terminal.as_ref(), scheme_name) {
        (Some(settings), Some(name)) => settings
            .get("schemes")
            .and_then(|s| s.as_array())
            .and_then(|list| list.iter().find(|s| s.get("name").and_then(|n| n.as_str()) == Some(name.as_str())))
            .cloned(),
        _ => None,
    };
    AppInfo {
        home: path_string(&home()),
        data_dir: path_string(&data_dir()),
        claude_dir: path_string(&main_claude_dir()),
        claude_path: find_in_path(&["claude.exe", "claude.cmd"]).map(|p| path_string(&p)),
        shells: shells(),
        terminal_image: image,
        terminal_image_opacity: opacity,
        terminal_scheme: scheme,
    }
}

#[tauri::command]
pub async fn image_data_url(path: String) -> Result<String, String> {
    blocking(move || {
        let target = PathBuf::from(&path);
        let bytes = std::fs::read(&target).map_err(err)?;
        Ok(format!(
            "data:{};base64,{}",
            mime_for(&target),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
}
