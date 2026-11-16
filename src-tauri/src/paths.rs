use std::path::PathBuf;

pub fn home() -> PathBuf {
    match std::env::var_os("MAVIX_HOME") {
        Some(custom) => PathBuf::from(custom),
        None => dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\")),
    }
}

pub fn main_claude_dir() -> PathBuf {
    home().join(".claude")
}

pub fn main_claude_json() -> PathBuf {
    home().join(".claude.json")
}

pub fn data_dir() -> PathBuf {
    let dir = match std::env::var_os("MAVIX_DATA") {
        Some(custom) => PathBuf::from(custom),
        None => dirs::config_dir().unwrap_or_else(home).join("Mavix"),
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}
