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

use crate::activity::Activity;
use crate::media::{DiskFileInfo, MediaFiles};

/// The files picked in the save dialog, each good for one export; those being
/// written; and those finished, which may be shown.
#[derive(Default)]
pub struct Exports {
    picked: Mutex<HashSet<PathBuf>>,
    open: Mutex<HashMap<u32, (PathBuf, File, Activity)>>,
    saved: Mutex<HashSet<PathBuf>>,
    /// The files closed and kept, by the id they were written under: a
    /// cancelled export may still be discarded after its muxer closed it.
    kept: Mutex<HashMap<u32, PathBuf>>,
    /// Folders picked for the files the editor makes itself (clips converted,
    /// recordings, speech), written into without asking for each file.
    folders: Mutex<HashSet<PathBuf>>,
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

    /// A file to export to, as the save dialog gives one.
    pub fn add_pick(&self, path: PathBuf) {
        lock(&self.picked).insert(path);
    }

    /// A finished export, which may be shown.
    pub fn add_saved(&self, path: PathBuf) {
        lock(&self.saved).insert(path);
    }

    /// A folder the editor may write its own files into, as one picked.
    pub fn add_folder(&self, folder: PathBuf) {
        lock(&self.folders).insert(folder);
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
    exports.add_pick(path);
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
    let activity = Activity::begin("Exporting a film");
    lock(&exports.open).insert(id, (path, file, activity));
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
    let (_, file, _) = open.get_mut(&id).ok_or("no such export")?;
    file.seek(SeekFrom::Start(position))
        .and_then(|_| file.write_all(bytes))
        .map_err(|error| error.to_string())
}

/// Finishes an export: kept, or deleted when it was cancelled or failed,
/// even once kept: a muxer closes its file when it's cancelled, before the
/// export is discarded.
#[tauri::command]
pub fn close_export_file(exports: State<'_, Exports>, id: u32, keep: bool) -> Result<(), String> {
    let Some((path, file, _activity)) = lock(&exports.open).remove(&id) else {
        if keep {
            return Err("no such export".into());
        }
        let path = lock(&exports.kept).remove(&id).ok_or("no such export")?;
        lock(&exports.saved).remove(&path);
        return fs::remove_file(&path).map_err(|error| error.to_string());
    };
    if keep {
        file.sync_all().map_err(|error| error.to_string())?;
        lock(&exports.kept).insert(id, path.clone());
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

/// The folder dialog, opening in `directory` if there is one: the folder the
/// editor may then write its files into, or none if cancelled.
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    exports: State<'_, Exports>,
    title: String,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(directory) = directory.map(PathBuf::from).filter(|path| path.is_dir()) {
        dialog = dialog.set_directory(directory);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|error| error.to_string())?;
    let Some(folder) = picked.and_then(|folder| folder.into_path().ok()) else {
        return Ok(None);
    };
    let shown = folder
        .to_str()
        .map(str::to_owned)
        .ok_or("not a UTF-8 path")?;
    lock(&exports.folders).insert(folder);
    Ok(Some(shown))
}

/// The folder recordings go in until another is picked: MagnetCut in the
/// user's Music folder, made if it isn't there, and one the editor may write
/// its files into.
#[tauri::command]
pub fn recordings_folder(app: AppHandle, exports: State<'_, Exports>) -> Result<String, String> {
    let folder = app
        .path()
        .audio_dir()
        .map_err(|error| error.to_string())?
        .join("MagnetCut");
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let shown = folder
        .to_str()
        .map(str::to_owned)
        .ok_or("not a UTF-8 path")?;
    lock(&exports.folders).insert(folder);
    Ok(shown)
}

/// The folder proxies go in (docs/CONFORM.md, phase 4): Proxies in the app's
/// cache, made if it isn't there, as they can be made again; one the editor may
/// write its files into.
#[tauri::command]
pub fn proxies_folder(app: AppHandle, exports: State<'_, Exports>) -> Result<String, String> {
    let folder = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("Proxies");
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let shown = folder
        .to_str()
        .map(str::to_owned)
        .ok_or("not a UTF-8 path")?;
    lock(&exports.folders).insert(folder);
    Ok(shown)
}

/// A name that's only a file's name, with nothing that would make it a path.
fn file_name_only(name: &str) -> Option<&str> {
    let name = name.trim();
    let is_plain = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control);
    is_plain.then_some(name)
}

/// `name` in `folder`, or with " 2", " 3"… before its extension if that's
/// taken: a file the editor makes never replaces one that's there.
fn unused_path(folder: &Path, name: &str) -> PathBuf {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    };
    let mut count = 1;
    loop {
        let candidate = match (count, extension) {
            (1, _) => name.to_owned(),
            (_, Some(extension)) => format!("{stem} {count}.{extension}"),
            (_, None) => format!("{stem} {count}"),
        };
        let path = folder.join(candidate);
        if !path.exists() {
            return path;
        }
        count += 1;
    }
}

/// A file started in a picked folder, written as an export is.
#[derive(serde::Serialize)]
pub struct FolderFile {
    id: u32,
    path: String,
}

/// Starts writing a new file named `name` in a folder picked with
/// `pick_folder`; then `write_export_file` and `close_export_file`, as for an
/// export, and `adopt_saved_file` to use it as media.
#[tauri::command]
pub fn open_folder_file(
    exports: State<'_, Exports>,
    folder: String,
    name: String,
) -> Result<FolderFile, String> {
    let folder = PathBuf::from(folder);
    if !lock(&exports.folders).contains(&folder) {
        return Err("not a folder picked here".into());
    }
    let name = file_name_only(&name).ok_or("not a file name")?;
    let path = unused_path(&folder, name);
    let shown = path.to_str().map(str::to_owned).ok_or("not a UTF-8 path")?;
    let file = File::create_new(&path).map_err(|error| error.to_string())?;
    let id = exports.next_id.fetch_add(1, Ordering::Relaxed);
    let activity = Activity::begin("Writing a file");
    lock(&exports.open).insert(id, (path, file, activity));
    Ok(FolderFile { id, path: shown })
}

/// A file this app finished writing, given to the editor as media, as if it
/// had been picked in the open dialog.
#[tauri::command]
pub fn adopt_saved_file(
    exports: State<'_, Exports>,
    media: State<'_, MediaFiles>,
    path: String,
) -> Result<DiskFileInfo, String> {
    let path = PathBuf::from(path);
    if !lock(&exports.saved).contains(&path) {
        return Err("not a file written here".into());
    }
    media
        .grant(vec![path])
        .pop()
        .ok_or_else(|| "not a kind of file the editor opens".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_with_a_path_in_them_are_refused() {
        assert_eq!(file_name_only(" take 1.wav "), Some("take 1.wav"));
        for name in ["", ".", "..", "a/b.wav", "a\\b.wav", "c:.wav", "a\nb.wav"] {
            assert_eq!(file_name_only(name), None, "{name:?}");
        }
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let folder = std::env::temp_dir().join(format!("magnetcut-unused-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(unused_path(&folder, "a.wav"), folder.join("a.wav"));
        File::create(folder.join("a.wav")).unwrap();
        File::create(folder.join("a 2.wav")).unwrap();
        assert_eq!(unused_path(&folder, "a.wav"), folder.join("a 3.wav"));
        File::create(folder.join("b")).unwrap();
        assert_eq!(unused_path(&folder, "b"), folder.join("b 2"));
        fs::remove_dir_all(&folder).unwrap();
    }
}
