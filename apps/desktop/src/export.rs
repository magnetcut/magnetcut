// Exports written to the file the user picked as the editor makes them
// (docs/NATIVE.md, phase 2), rather than kept in memory whole and downloaded:
// the save dialog, then the muxer's chunks, each at its position.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The files picked in the save dialog, each good for one export; those being
/// written; and those finished, which may be shown.
#[derive(Default)]
pub struct Exports {
    picked: Mutex<HashSet<PathBuf>>,
    open: Mutex<HashMap<u32, (PathBuf, File)>>,
    saved: Mutex<HashSet<PathBuf>>,
    next_id: AtomicU32,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Exports {
    /// Uses up a pick from the save dialog: another export asks again.
    pub fn take_pick(&self, path: &Path) -> Result<(), String> {
        if !lock(&self.picked).remove(path) {
            return Err("not a file picked in the save dialog".into());
        }
        Ok(())
    }

    /// A finished export, which may be shown.
    pub fn add_saved(&self, path: PathBuf) {
        lock(&self.saved).insert(path);
    }
}

/// The save dialog for an export, opening in `directory` if there is one (as
/// HandBrake does, beside the source): where it goes, or none if cancelled.
#[tauri::command]
pub async fn pick_export_file(
    app: AppHandle,
    exports: State<'_, Exports>,
    name: String,
    extension: String,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(format!("{name}.{extension}"))
        .add_filter(extension.to_uppercase(), &[extension.as_str()]);
    if let Some(directory) = directory.map(PathBuf::from).filter(|path| path.is_dir()) {
        dialog = dialog.set_directory(directory);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(None);
    };
    let shown = path.to_str().map(str::to_owned).ok_or("not a UTF-8 path")?;
    lock(&exports.picked).insert(path);
    Ok(Some(shown))
}

/// Starts writing an export to a file picked in the save dialog, replacing
/// what was there. A pick is used up: another export asks again.
#[tauri::command]
pub fn open_export_file(exports: State<'_, Exports>, path: String) -> Result<u32, String> {
    let path = PathBuf::from(path);
    exports.take_pick(&path)?;
    let file = File::create(&path).map_err(|error| error.to_string())?;
    let id = exports.next_id.fetch_add(1, Ordering::Relaxed);
    lock(&exports.open).insert(id, (path, file));
    Ok(id)
}

/// Writes a chunk at its position: the body is the bytes, the `export-id` and
/// `position` headers say where.
#[tauri::command]
pub fn write_export_file(exports: State<'_, Exports>, request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<u64, String> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| format!("no {name} header"))
    };
    let id = u32::try_from(header("export-id")?).map_err(|error| error.to_string())?;
    let position = header("position")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the chunk isn't raw bytes".into());
    };
    let mut open = lock(&exports.open);
    let (_, file) = open.get_mut(&id).ok_or("no such export")?;
    file.seek(SeekFrom::Start(position))
        .and_then(|_| file.write_all(bytes))
        .map_err(|error| error.to_string())
}

/// Finishes an export: kept, or deleted when it was cancelled or failed.
#[tauri::command]
pub fn close_export_file(exports: State<'_, Exports>, id: u32, keep: bool) -> Result<(), String> {
    let (path, file) = lock(&exports.open).remove(&id).ok_or("no such export")?;
    if keep {
        file.sync_all().map_err(|error| error.to_string())?;
        exports.add_saved(path);
        return Ok(());
    }
    drop(file);
    fs::remove_file(&path).map_err(|error| error.to_string())
}

/// Shows a finished export in Finder, Explorer or the file manager.
#[tauri::command]
pub fn reveal_export_file(exports: State<'_, Exports>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !lock(&exports.saved).contains(&path) {
        return Err("not an export saved here".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| error.to_string())
}
