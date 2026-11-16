use crate::paths::data_dir;
use crate::util::{err, write_atomic};

#[tauri::command]
pub fn state_load() -> Result<Option<String>, String> {
    let path = data_dir().join("workspace.json");
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path).map(Some).map_err(err)
}

#[tauri::command]
pub fn state_save(json: String) -> Result<(), String> {
    write_atomic(&data_dir().join("workspace.json"), json.as_bytes())
}
