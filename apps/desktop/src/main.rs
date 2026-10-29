// The desktop app: the editor (apps/web, exported as static files) in a window.

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod menu;

use serde::Serialize;
use tauri::Emitter;
use tauri::webview::PageLoadEvent;

/// With MAGNETCUT_PROBE set, each page reports what the system's web view can
/// do (src/probe.js), the report is printed as one JSON line, and the app quits.
const PROBE_ENV: &str = "MAGNETCUT_PROBE";

#[tauri::command]
fn probe_report(app: tauri::AppHandle, report: String) {
    println!("MAGNETCUT_PROBE {report}");
    app.exit(0);
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    /// Whether this edition updates itself: not the App Store one.
    updates: bool,
}

/// What the About box and Settings show.
#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        updates: cfg!(feature = "updater"),
    }
}

fn main() {
    // Links with target="_blank" open in the browser.
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(feature = "updater")]
    {
        // The feed and the public key that every update must be signed with
        // are in tauri.conf.json (plugins.updater).
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(menu::build);
    }
    builder = builder.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if menu::is_forwarded(id)
            && let Err(error) = app.emit_to("main", "menu", id)
        {
            eprintln!("menu: {error}");
        }
    });

    if std::env::var_os(PROBE_ENV).is_some() {
        builder = builder
            .invoke_handler(tauri::generate_handler![app_info, probe_report])
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Finished
                    && let Err(error) = webview.eval(include_str!("probe.js"))
                {
                    eprintln!("probe: {error}");
                }
            });
    } else {
        builder = builder.invoke_handler(tauri::generate_handler![app_info]);
    }
    builder
        .run(tauri::generate_context!())
        .expect("error while running MagnetCut");
}
