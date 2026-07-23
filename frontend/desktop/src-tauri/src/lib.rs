use keyring::Entry;
use std::sync::Mutex;

const RUNNER_HTML: &str =
    include_str!("../../../../backend-services/4-public-sites/sites-worker/src/runner.html");
const RUNNER_PARENT_ORIGINS: &str = "tauri://localhost,http://tauri.localhost,http://localhost:1420";
const RUNNER_CSP: &str = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors tauri://localhost http://tauri.localhost http://localhost:1420";

#[tauri::command]
fn seal_secret(service: String, account: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn unseal_secret(service: String, account: String) -> Result<String, String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_secret(service: String, account: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes a small `.mmp` shortcut file: a `memoza://` deep link on the first
/// line, a friendly display name on the second. Double-clicking it (once the
/// desktop app registers the `.mmp` file association at install time) should
/// relaunch/focus Memoza with that path as an argument — see
/// `pending_mmp_url` below.
#[tauri::command]
fn create_shortcut(path: String, url: String, name: String) -> Result<(), String> {
    let contents = format!("{}\n{}\n", url, name);
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn take_pending_mmp_url(state: tauri::State<PendingMmpUrl>) -> Option<String> {
    state.0.lock().unwrap().take()
}

struct PendingMmpUrl(Mutex<Option<String>>);

fn extract_mmp_url_from_args() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| arg.to_lowercase().ends_with(".mmp"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| contents.lines().next().map(str::trim).map(str::to_string))
        .filter(|url| !url.is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("sandbox", |_ctx, _request| {
            let html = RUNNER_HTML.replace("__PARENT_ORIGINS__", RUNNER_PARENT_ORIGINS);
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", RUNNER_CSP)
                .body(html.into_bytes())
                .unwrap()
        })
        .manage(PendingMmpUrl(Mutex::new(extract_mmp_url_from_args())))
        .invoke_handler(tauri::generate_handler![
            seal_secret,
            unseal_secret,
            clear_secret,
            create_shortcut,
            take_pending_mmp_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Memoza desktop shell");
}
