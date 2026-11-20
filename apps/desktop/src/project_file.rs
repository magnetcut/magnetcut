// Projects as files (.magnetcut, docs/AUTOMATION.md), for the user: Open
// Project… and Save Project As…, through the system's dialogs, and a project
// file opened with MagnetCut (src/opened.rs). The editor gets the file picked
// or opened and the media in it opened for it, never a path of its own
// choosing (as src/media.rs).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::agent::media_paths;
use crate::dialog::AnyCaseFilter;
use crate::media::MediaFiles;

const EXTENSION: &str = "magnetcut";

/// A project file picked or opened: where it is, and what's in it.
#[derive(Serialize)]
pub struct Picked {
    path: String,
    text: String,
}

/// Whether a file is a project file, by its extension in any case.
pub fn is_project_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(EXTENSION))
}

/// A project file's text, its media opened for the editor.
pub fn read_project(path: &Path, media: &MediaFiles) -> Result<Picked, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("Couldn't read it: {error}"))?;
    media.grant(media_paths(&text).into_iter().map(PathBuf::from).collect());
    let path = path.to_str().map(str::to_owned).ok_or("not a UTF-8 path")?;
    Ok(Picked { path, text })
}

/// The open dialog, for a project file: its text, its media opened for the
/// editor, as if picked too.
#[tauri::command]
pub async fn pick_project_file(
    app: AppHandle,
    media: State<'_, MediaFiles>,
) -> Result<Option<Picked>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .add_any_case_filter("MagnetCut project", &[EXTENSION]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(None);
    };
    read_project(&path, &media).map(Some)
}

/// The save dialog, for a project file, then the file written: where.
#[tauri::command]
pub async fn save_project_file(
    app: AppHandle,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(format!("{name}.{EXTENSION}"))
        .add_any_case_filter("MagnetCut project", &[EXTENSION]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&path, text).map_err(|error| format!("Couldn't save it: {error}"))?;
    Ok(path.to_str().map(str::to_owned))
}
