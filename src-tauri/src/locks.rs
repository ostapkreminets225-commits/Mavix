use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
use windows_sys::Win32::System::RestartManager::{CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmEndSession, RmGetList, RmRegisterResources, RmStartSession};

const MAX_FILES: usize = 4000;

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn collect(path: &Path, out: &mut Vec<Vec<u16>>) {
    if out.len() >= MAX_FILES {
        return;
    }
    if path.is_dir() {
        let Ok(entries) = std::fs::read_dir(path) else { return };
        for entry in entries.flatten() {
            collect(&entry.path(), out);
            if out.len() >= MAX_FILES {
                return;
            }
        }
    } else {
        out.push(wide(path));
    }
}

fn app_name(info: &RM_PROCESS_INFO) -> String {
    let len = info.strAppName.iter().position(|c| *c == 0).unwrap_or(info.strAppName.len());
    let name = String::from_utf16_lossy(&info.strAppName[..len]);
    let name = if name.trim().is_empty() { "невідома програма".to_string() } else { name };
    format!("{name} (PID {})", info.Process.dwProcessId)
}

pub fn holders(path: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect(path, &mut files);
    if files.is_empty() {
        return Vec::new();
    }
    let pointers: Vec<*const u16> = files.iter().map(|f| f.as_ptr()).collect();
    let mut names = Vec::new();
    unsafe {
        let mut session = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
            return names;
        }
        if RmRegisterResources(session, pointers.len() as u32, pointers.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) == 0 {
            let mut needed = 0u32;
            let mut count = 0u32;
            let mut reasons = 0u32;
            let first = RmGetList(session, &mut needed, &mut count, std::ptr::null_mut(), &mut reasons);
            if first == ERROR_MORE_DATA && needed > 0 {
                let mut infos: Vec<RM_PROCESS_INFO> = (0..needed).map(|_| RM_PROCESS_INFO::default()).collect();
                count = needed;
                if RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reasons) == 0 {
                    for info in infos.iter().take(count as usize) {
                        let label = app_name(info);
                        if !names.contains(&label) {
                            names.push(label);
                        }
                    }
                }
            }
        }
        RmEndSession(session);
    }
    names
}
