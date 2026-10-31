// The desktop app: the editor (apps/web, exported as static files) in a window.

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod agent;
mod export;
mod media;
mod menu;
mod project_file;
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
            render::native_export_capabilities,
            render::native_export_probe,
            render::native_export_start,
            render::native_export_texture,
            render::native_export_frame,
            render::native_export_audio,
            render::native_export_finish,
            render::native_export_cancel,
            agent::agent_settings,
            agent::agent_set_enabled,
            agent::agent_add,
            agent::agent_revoke,
            agent::agent_register_tools,
            agent::agent_reply,
            agent::agent_progress,
            agent::agent_open_media,
            agent::agent_export_to,
            agent::agent_read_project,
            agent::agent_write_project,
            agent::agent_add_folder,
            agent::agent_remove_folder,
            project_file::pick_project_file,
            project_file::save_project_file,
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

/// For the probe, which exports through the app's own commands: two files in
/// a scratch folder to export to, as if picked in the save dialog.
#[tauri::command]
fn probe_export_paths(exports: tauri::State<'_, export::Exports>) -> Result<Vec<String>, String> {
    let directory = std::env::temp_dir().join("magnetcut-probe");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    ["first.mp4", "second.mp4"]
        .into_iter()
        .map(|name| {
            let path = directory.join(name);
            let shown = path.to_str().map(str::to_owned).ok_or("not a UTF-8 path")?;
            exports.add_pick(path);
            Ok(shown)
        })
        .collect()
}

/// For the probe: lets the editor read a film it exported, as if dropped.
#[tauri::command]
fn probe_grant(media: tauri::State<'_, media::MediaFiles>, path: String) -> Result<(), String> {
    match media.grant(vec![std::path::PathBuf::from(path)]).len() {
        1 => Ok(()),
        _ => Err("not a media file".into()),
    }
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
    // The command line's agent modes, `--mcp` and `call` (src/agent/cli.rs):
    // no window.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = agent::cli::run(&args) {
        std::process::exit(code);
    }
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
        app.manage(render::NativeExports::default());
        app.manage(agent::Agents::load(app.handle()));
        // For agents on their own: the app without its window.
        if std::env::args().any(|arg| arg == "--hidden")
            && let Some(window) = app.get_webview_window("main")
        {
            window.hide()?;
        }
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
            .invoke_handler(commands![probe_report, probe_export_paths, probe_grant])
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
