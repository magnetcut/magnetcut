// The desktop app: the editor (apps/web, exported as static files) in a window.

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::PageLoadEvent;

/// With MAGNETCUT_PROBE set, each page reports what the system's web view can
/// do (src/probe.js), the report is printed as one JSON line, and the app quits.
const PROBE_ENV: &str = "MAGNETCUT_PROBE";

#[tauri::command]
fn probe_report(app: tauri::AppHandle, report: String) {
    println!("MAGNETCUT_PROBE {report}");
    app.exit(0);
}

fn main() {
    let mut builder = tauri::Builder::default();
    if std::env::var_os(PROBE_ENV).is_some() {
        builder = builder
            .invoke_handler(tauri::generate_handler![probe_report])
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Finished
                    && let Err(error) = webview.eval(include_str!("probe.js"))
                {
                    eprintln!("probe: {error}");
                }
            });
    }
    builder
        .run(tauri::generate_context!())
        .expect("error while running MagnetCut");
}
