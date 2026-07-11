use keyring::Entry;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![seal_secret, unseal_secret, clear_secret])
        .run(tauri::generate_context!())
        .expect("error while running the Memoza desktop shell");
}
