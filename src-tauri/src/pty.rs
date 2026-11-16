use crate::accounts;
use crate::paths::home;
use crate::util::{err, find_in_path};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const STRIPPED_ENV: [&str; 4] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CONFIG_DIR"];

static GENERATION: AtomicU64 = AtomicU64::new(1);

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    generation: u64,
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Session>>);

impl Terminals {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut session) in map.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    id: String,
    shell_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    startup: Option<String>,
    account_id: Option<String>,
}

#[derive(Serialize, Clone)]
struct TermData {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct TermExit {
    id: String,
    code: u32,
}

fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
}

pub fn shells() -> Vec<ShellInfo> {
    let root = system_root();
    let candidates: Vec<(&str, &str, Option<PathBuf>)> = vec![
        (
            "pwsh",
            "PowerShell 7",
            find_in_path(&["pwsh.exe"]).or_else(|| Some(program_files().join(r"PowerShell\7\pwsh.exe"))),
        ),
        ("powershell", "PowerShell", Some(root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))),
        ("cmd", "Command Prompt", Some(root.join(r"System32\cmd.exe"))),
        ("bash", "Git Bash", Some(program_files().join(r"Git\bin\bash.exe"))),
        ("wsl", "WSL", Some(root.join(r"System32\wsl.exe"))),
    ];
    candidates
        .into_iter()
        .filter_map(|(id, name, path)| {
            let path = path?;
            path.is_file().then(|| ShellInfo { id: id.into(), name: name.into(), path: path.to_string_lossy().into() })
        })
        .collect()
}

fn launch_args(shell_id: &str, startup: Option<&str>) -> Vec<String> {
    let owned = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match (shell_id, startup) {
        ("pwsh" | "powershell", None) => owned(&["-NoLogo"]),
        ("pwsh" | "powershell", Some(command)) => owned(&["-NoLogo", "-NoExit", "-Command", command]),
        ("cmd", None) => vec![],
        ("cmd", Some(command)) => owned(&["/K", command]),
        ("bash", None) => owned(&["--login", "-i"]),
        ("bash", Some(command)) => vec!["--login".into(), "-i".into(), "-c".into(), format!("{command}; exec bash --login -i")],
        ("wsl", Some(command)) => vec!["-e".into(), "bash".into(), "-lc".into(), format!("{command}; exec bash -l")],
        _ => vec![],
    }
}

fn complete_utf8_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

#[tauri::command]
pub fn term_shells() -> Vec<ShellInfo> {
    shells()
}

#[tauri::command]
pub fn term_spawn(app: AppHandle, terms: State<Terminals>, req: SpawnRequest) -> Result<u32, String> {
    let available = shells();
    let shell = available
        .iter()
        .find(|s| s.id == req.shell_id)
        .or_else(|| available.iter().find(|s| s.id == "powershell"))
        .or(available.first())
        .ok_or("Не знайдено жодної оболонки")?
        .clone();

    let pair = native_pty_system()
        .openpty(PtySize { rows: req.rows.max(2), cols: req.cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;

    let mut command = CommandBuilder::new(&shell.path);
    command.args(launch_args(&shell.id, req.startup.as_deref()));
    let cwd = Path::new(&req.cwd);
    command.cwd(if cwd.is_dir() { cwd.to_path_buf() } else { home() });
    for key in STRIPPED_ENV {
        command.env_remove(key);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Mavix");
    if let Some(dir) = req.account_id.as_deref().and_then(accounts::extra_config_dir) {
        command.env("CLAUDE_CONFIG_DIR", dir);
    }

    let mut child = pair.slave.spawn_command(command).map_err(err)?;
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);

    let replaced = terms.0.lock().map_err(err)?.insert(req.id.clone(), Session { master: pair.master, writer, killer, generation });
    if let Some(mut old) = replaced {
        let _ = old.killer.kill();
    }

    let reader_app = app.clone();
    let reader_id = req.id.clone();
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 32 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    let ready = complete_utf8_len(&pending);
                    if ready > 0 {
                        let data = String::from_utf8_lossy(&pending[..ready]).into_owned();
                        pending.drain(..ready);
                        if is_current(&reader_app, &reader_id, generation) {
                            let _ = reader_app.emit("term-data", TermData { id: reader_id.clone(), data });
                        }
                    }
                }
            }
        }
    });

    let waiter_app = app.clone();
    let waiter_id = req.id.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        std::thread::sleep(Duration::from_millis(150));
        let removed = waiter_app.state::<Terminals>().0.lock().ok().and_then(|mut map| {
            let current = map.get(&waiter_id).is_some_and(|s| s.generation == generation);
            if current { map.remove(&waiter_id) } else { None }
        });
        if let Some(session) = removed {
            drop(session);
            let _ = waiter_app.emit("term-exit", TermExit { id: waiter_id, code });
        }
    });

    Ok(pid)
}

fn is_current(app: &AppHandle, id: &str, generation: u64) -> bool {
    app.state::<Terminals>().0.lock().map(|map| map.get(id).is_some_and(|s| s.generation == generation)).unwrap_or(false)
}

#[tauri::command]
pub fn term_write(terms: State<Terminals>, id: String, data: String) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(err)?;
    let session = map.get_mut(&id).ok_or("Термінал уже закрито")?;
    session.writer.write_all(data.as_bytes()).map_err(err)?;
    session.writer.flush().map_err(err)
}

#[tauri::command]
pub fn term_resize(terms: State<Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.0.lock().map_err(err)?;
    if let Some(session) = map.get(&id) {
        session
            .master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn term_kill(terms: State<Terminals>, id: String) -> Result<(), String> {
    let removed = terms.0.lock().map_err(err)?.remove(&id);
    if let Some(mut session) = removed {
        let _ = session.killer.kill();
    }
    Ok(())
}
