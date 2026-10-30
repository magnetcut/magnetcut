// The desktop app: the editor (apps/web, exported as static files) in a window.

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod export;
mod media;
// Phase 5's start: what the system has, so far only for the tests.
#[cfg(all(windows, test))]
mod media_foundation;
mod menu;
#[cfg(target_os = "macos")]
mod render;
#[cfg(target_os = "linux")]
mod webkit;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};

/// The commands the editor calls, and any more given.
macro_rules! commands {
    ($($more:path),*) => {
        tauri::generate_handler![
            app_info,
            media::pick_media_files,
            media::dropped_media_files,
            media::media_file_info,
            media::read_media_file,
            export::pick_export_file,
            export::open_export_file,
            export::write_export_file,
            export::close_export_file,
            export::reveal_export_file,
            #[cfg(target_os = "macos")]
            render::native_export_capabilities,
            #[cfg(target_os = "macos")]
            render::native_export_probe,
            #[cfg(target_os = "macos")]
            render::native_export_start,
            #[cfg(target_os = "macos")]
            render::native_export_texture,
            #[cfg(target_os = "macos")]
            render::native_export_frame,
            #[cfg(target_os = "macos")]
            render::native_export_audio,
            #[cfg(target_os = "macos")]
            render::native_export_finish,
            #[cfg(target_os = "macos")]
            render::native_export_cancel,
            $($more),*
        ]
    };
}

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

/// Whether the window may load `url`: only the app's own pages. A file or link
/// dropped where the editor doesn't take it would otherwise open in its place,
/// as in a browser.
fn is_own_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        // The dev server, and the app's origin on Windows.
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "tauri.localhost")),
        _ => false,
    }
}

fn main() {
    // Links with target="_blank" open in the browser.
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("own-pages")
                .on_navigation(|_, url| is_own_page(url))
                .build(),
        );
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
    builder = builder.setup(|app| {
        app.manage(media::MediaFiles::load(app.handle()));
        app.manage(export::Exports::default());
        #[cfg(target_os = "macos")]
        app.manage(render::NativeExports::default());
        // Before the first page loads: the window exists, and with_webview
        // runs at once on the main thread, which serves the page.
        #[cfg(target_os = "linux")]
        if let Some(window) = app.get_webview_window("main") {
            let probing = std::env::var_os(PROBE_ENV).is_some();
            window.with_webview(move |webview| {
                let features = webkit::enable_needed(&webview.inner());
                if probing {
                    let features = serde_json::to_string(&features).unwrap_or_default();
                    println!("MAGNETCUT_WEBKIT_FEATURES {features}");
                }
            })?;
        }
        Ok(())
    });
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
            .invoke_handler(commands![probe_report])
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Finished
                    && let Err(error) = webview.eval(include_str!("probe.js"))
                {
                    eprintln!("probe: {error}");
                }
            });
    } else {
        builder = builder.invoke_handler(commands![]);
    }
    builder
        .run(tauri::generate_context!())
        .expect("error while running MagnetCut");
}
