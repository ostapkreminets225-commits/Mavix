mod accounts;
mod chat;
mod files;
mod locks;
mod paths;
mod pty;
mod rules;
mod sessions;
mod skill_usage;
mod skills;
mod slack;
mod store;
mod structure;
mod system;
mod util;

use tauri::Manager;

pub const RULES_HOOK_FLAG: &str = rules::HOOK_FLAG;
pub const SLACK_MCP_FLAG: &str = slack::MCP_FLAG;

pub fn rules_hook(kind: &str) {
    rules::run_hook(kind);
}

pub fn slack_mcp() {
    slack::run_mcp();
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Terminals::default())
        .manage(chat::Chats::default())
        .manage(sessions::SessionCache::default())
        .invoke_handler(tauri::generate_handler![
            system::app_info,
            system::image_data_url,
            store::state_load,
            store::state_save,
            pty::term_shells,
            pty::term_spawn,
            pty::term_write,
            pty::term_resize,
            pty::term_kill,
            chat::chat_start,
            chat::chat_send,
            chat::chat_stop,
            chat::chat_history,
            rules::rules_load,
            rules::rules_save,
            slack::slack_load,
            slack::slack_connect,
            slack::slack_disconnect,
            slack::slack_chats,
            slack::slack_select,
            slack::slack_digest,
            files::fs_list,
            files::fs_read_text,
            files::fs_write_text,
            files::fs_read_data_url,
            files::fs_create_file,
            files::fs_create_dir,
            files::fs_rename,
            files::fs_trash,
            files::fs_exists,
            files::fs_reveal,
            files::fs_walk,
            files::fs_search,
            files::open_external,
            files::git_branch,
            skills::skills_list,
            skills::skills_set_enabled,
            skills::skills_set_always,
            skills::skills_create,
            skills::skills_import,
            skills::skills_delete,
            skills::plugins_set_enabled,
            skills::skills_disable_all,
            skills::skills_enable_all,
            skills::skill_files,
            skills::skills_set_mine,
            skills::skills_project,
            skills::skills_project_set,
            skill_usage::skills_usage,
            accounts::accounts_list,
            accounts::accounts_add,
            accounts::accounts_update,
            accounts::accounts_set_default,
            accounts::accounts_remove,
            accounts::accounts_sync,
            accounts::accounts_refresh_usage,
            sessions::sessions_list,
            sessions::session_read,
            sessions::session_exists,
            sessions::session_copy_to_account,
            structure::structure_templates,
            structure::structure_save,
            structure::structure_plan,
            structure::structure_apply,
            structure::structure_capture,
            structure::structure_write_claude_md,
            structure::project_create,
        ])
        .build(tauri::generate_context!())
        .expect("Mavix не зміг запуститися");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<pty::Terminals>().kill_all();
            handle.state::<chat::Chats>().kill_all();
        }
    });
}
