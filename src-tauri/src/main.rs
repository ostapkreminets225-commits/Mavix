#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|a| a == mavix_lib::RULES_HOOK_FLAG) {
        mavix_lib::rules_hook(args.get(index + 1).map(String::as_str).unwrap_or("prompt"));
        return;
    }
    if args.iter().any(|a| a == mavix_lib::SLACK_MCP_FLAG) {
        mavix_lib::slack_mcp();
        return;
    }
    mavix_lib::run()
}
