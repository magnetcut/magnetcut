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
use crate::dialog::AnyCaseFilter;
use crate::media::{DiskFileInfo, MediaFiles};

/// The files picked in the save dialog, each good for one export; those being
/// written; and those finished, which may be shown.
#[derive(Default)]
pub struct Exports {
    picked: Mutex<HashSet<PathBuf>>,
    open: Mutex<HashMap<u32, Writing>>,
    saved: Mutex<HashSet<PathBuf>>,
    /// The files closed and kept, by the id they were written under: a
    /// cancelled export may still be discarded after its muxer closed it.
    kept: Mutex<HashMap<u32, PathBuf>>,
    /// Exports closed but not yet put in place (`commit_export_file`): where
    /// each was written, and the file it's to replace, untouched until then.
    closed: Mutex<HashMap<u32, (PathBuf, PathBuf)>>,
    /// Folders picked for the files the editor makes itself (clips converted,
    /// recordings, speech), written into without asking for each file.
    folders: Mutex<HashSet<PathBuf>>,
    next_id: AtomicU32,
}

/// A file being written: where, and for an export, the file it's to replace
/// once it's finished.
struct Writing {
    path: PathBuf,
    replaces: Option<PathBuf>,
    file: File,
    _activity: Activity,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// An export's name until it's finished: "film (exporting).mp4".
fn partial_name(target: &Path) -> Result<String, String> {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("not a UTF-8 path")?;
    Ok(match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem} (exporting).{extension}"),
        _ => format!("{name} (exporting)"),
    })
}

/// Where an export is written until it's finished: beside the file it's to
/// replace, so that one rename puts it there, under a name that's not in use.
pub fn partial_path(target: &Path) -> Result<PathBuf, String> {
    let folder = target.parent().ok_or("not a file's path")?;
    Ok(unused_path(folder, &partial_name(target)?))
}

/// Starts the file an export is written to until it's finished (see
/// `partial_path`); in a folder of the app's own where it may not make one
/// beside it (the App Store edition may write only the file picked). The file
/// picked stays as it was until the export is put in its place: if it's
/// cancelled or fails, that file is never touched.
pub fn create_partial(target: &Path) -> Result<(PathBuf, File), String> {
    let beside = partial_path(target)?;
    match File::create_new(&beside) {
        Ok(file) => Ok((beside, file)),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            let folder = own_exports_folder()?;
            let path = unused_path(&folder, &partial_name(target)?);
            let file = File::create_new(&path).map_err(|error| error.to_string())?;
            Ok((path, file))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Where exports are written that can't be beside the file picked: the
/// user's own cache (in the App Store edition, the container's), not a
/// shared folder such as Linux's /tmp, where another user could make it
/// first and read the export, or put a link in its place.
fn own_exports_folder() -> Result<PathBuf, String> {
    let folder = match dirs::cache_dir() {
        Some(cache) => cache.join("MagnetCut").join("Exports"),
        None => std::env::temp_dir().join("MagnetCut exports"),
    };
    if let Some(parent) = folder.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    make_own_folder(&folder)?;
    Ok(folder)
}

/// Makes `folder`, readable by the user only, or checks that the one there is
/// a folder of theirs, not a link, and makes it so.
#[cfg(unix)]
fn make_own_folder(folder: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match fs::DirBuilder::new().mode(0o700).create(folder) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(folder).map_err(|error| error.to_string())?;
    // SAFETY: geteuid has no preconditions and can't fail.
    let user = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != user {
        return Err(format!(
            "{} isn't a folder of this user's: the export can't be written there",
            folder.display()
        ));
    }
    if metadata.mode() & 0o077 != 0 {
        fs::set_permissions(folder, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Makes `folder`: the user's cache is theirs alone already.
#[cfg(not(unix))]
fn make_own_folder(folder: &Path) -> Result<(), String> {
    fs::create_dir_all(folder).map_err(|error| error.to_string())
}

/// Puts a finished export in the place of the file it replaces: renamed, or
/// copied where it can't be (from another disk, or in the App Store edition,
/// which may write that file but not its folder). If neither works (the file
/// is open in another app, on Windows), the export stays where it was
/// written, and the error says where.
pub fn put_in_place(partial: &Path, target: &Path) -> Result<(), String> {
    if fs::rename(partial, target).is_ok() {
        return Ok(());
    }
    fs::copy(partial, target).map_err(|error| {
        format!(
            "couldn't replace {}: {error}; the export is in {}",
            target.display(),
            partial.display()
        )
    })?;
    let _ = fs::remove_file(partial);
    Ok(())
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

    fn begin(&self, writing: Writing) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        lock(&self.open).insert(id, writing);
        id
    }

    /// Starts an export to a file picked in the save dialog, written beside
    /// it (`create_partial`) until `commit` puts it there.
    fn open_export(&self, target: PathBuf) -> Result<u32, String> {
        self.take_pick(&target)?;
        let (path, file) = create_partial(&target)?;
        Ok(self.begin(Writing {
            path,
            replaces: Some(target),
            file,
            _activity: Activity::begin("Exporting a film"),
        }))
    }

    fn close(&self, id: u32, keep: bool) -> Result<(), String> {
        let Some(writing) = lock(&self.open).remove(&id) else {
            if keep {
                return Err("no such export".into());
            }
            // Closed already: an export not yet put in place loses only what
            // it wrote; a file written in a folder, itself.
            if let Some((path, _)) = lock(&self.closed).remove(&id) {
                return fs::remove_file(&path).map_err(|error| error.to_string());
            }
            let path = lock(&self.kept).remove(&id).ok_or("no such export")?;
            lock(&self.saved).remove(&path);
            return fs::remove_file(&path).map_err(|error| error.to_string());
        };
        if !keep {
            let Writing { path, file, .. } = writing;
            drop(file);
            return fs::remove_file(&path).map_err(|error| error.to_string());
        }
        if let Err(error) = writing.file.sync_all() {
            // Still open, so that discarding it deletes it.
            lock(&self.open).insert(id, writing);
            return Err(error.to_string());
        }
        let Writing { path, replaces, .. } = writing;
        match replaces {
            Some(target) => {
                lock(&self.closed).insert(id, (path, target));
            }
            None => {
                lock(&self.kept).insert(id, path.clone());
                self.add_saved(path);
            }
        }
        Ok(())
    }

    fn commit(&self, id: u32) -> Result<(), String> {
        let (path, target) = lock(&self.closed)
            .remove(&id)
            .ok_or("no such export, or not closed")?;
        put_in_place(&path, &target)?;
        self.add_saved(target);
        Ok(())
    }

    /// The page writing these files is gone (reloaded, or its window
    /// closed), and won't finish them: exports not yet put in place are
    /// deleted, the files picked left as they were; files in folders (a take
    /// being recorded) are closed as they are, as a crash leaves them. The
    /// picks it hadn't used go too.
    pub fn abandon(&self) {
        let open: Vec<Writing> = lock(&self.open)
            .drain()
            .map(|(_, writing)| writing)
            .collect();
        for Writing {
            path,
            replaces,
            file,
            ..
        } in open
        {
            drop(file);
            if replaces.is_some() {
                let _ = fs::remove_file(&path);
            }
        }
        let closed: Vec<PathBuf> = lock(&self.closed)
            .drain()
            .map(|(_, (path, _))| path)
            .collect();
        for path in closed {
            let _ = fs::remove_file(&path);
        }
        lock(&self.kept).clear();
        lock(&self.picked).clear();
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
        .add_any_case_filter(&extension.to_uppercase(), &[extension.as_str()]);
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

/// Starts writing an export for a file picked in the save dialog: beside it,
/// until `commit_export_file` puts it in its place, replacing what was there.
/// A pick is used up: another export asks again.
#[tauri::command]
pub fn open_export_file(exports: State<'_, Exports>, path: String) -> Result<u32, String> {
    exports.open_export(PathBuf::from(path))
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
    let file = &mut open.get_mut(&id).ok_or("no such export")?.file;
    file.seek(SeekFrom::Start(position))
        .and_then(|_| file.write_all(bytes))
        .map_err(|error| error.to_string())
}

/// Closes a file: kept, or deleted when it was cancelled or failed, even once
/// kept: a muxer closes its file when it's cancelled, before the export is
/// discarded. Not once the editor has taken it as media (`adopt_saved_file`):
/// that file is the user's. An export kept is put in place only by
/// `commit_export_file`, as a cancelled export is closed too.
#[tauri::command]
pub fn close_export_file(exports: State<'_, Exports>, id: u32, keep: bool) -> Result<(), String> {
    exports.close(id, keep)
}

/// Puts an export that finished in the place of the file picked for it.
#[tauri::command]
pub fn commit_export_file(exports: State<'_, Exports>, id: u32) -> Result<(), String> {
    exports.commit(id)
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
    let id = exports.begin(Writing {
        path,
        replaces: None,
        file,
        _activity: Activity::begin("Writing a file"),
    });
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
    let info = media
        .grant(vec![path.clone()])
        .pop()
        .ok_or_else(|| "not a kind of file the editor opens".to_owned())?;
    lock(&exports.kept).retain(|_, kept| *kept != path);
    Ok(info)
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

    /// An empty folder of the test's own, with a film the user has in it.
    fn folder_with_a_film(name: &str) -> (PathBuf, PathBuf) {
        let folder =
            std::env::temp_dir().join(format!("magnetcut-export-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        let film = folder.join("film.mp4");
        fs::write(&film, b"the user's film").unwrap();
        (folder, film)
    }

    fn write(exports: &Exports, id: u32, bytes: &[u8]) {
        lock(&exports.open)
            .get_mut(&id)
            .unwrap()
            .file
            .write_all(bytes)
            .unwrap();
    }

    #[test]
    fn an_export_is_written_beside_the_file_it_replaces_under_a_name_not_in_use() {
        let (folder, film) = folder_with_a_film("partial");
        let partial = folder.join("film (exporting).mp4");
        assert_eq!(partial_path(&film).unwrap(), partial);
        File::create(&partial).unwrap();
        assert_eq!(
            partial_path(&film).unwrap(),
            folder.join("film (exporting) 2.mp4")
        );
        assert_eq!(
            partial_path(&folder.join("film")).unwrap(),
            folder.join("film (exporting)")
        );
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn an_export_replaces_the_file_picked_only_once_committed() {
        let (folder, film) = folder_with_a_film("commit");
        let exports = Exports::default();
        exports.add_pick(film.clone());
        let id = exports.open_export(film.clone()).unwrap();
        write(&exports, id, b"the export");
        exports.close(id, true).unwrap();
        assert_eq!(fs::read(&film).unwrap(), b"the user's film");
        assert!(!lock(&exports.saved).contains(&film));
        exports.commit(id).unwrap();
        assert_eq!(fs::read(&film).unwrap(), b"the export");
        assert!(lock(&exports.saved).contains(&film));
        assert_eq!(
            fs::read_dir(&folder).unwrap().count(),
            1,
            "the partial file is gone"
        );
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_cancelled_or_failed_export_leaves_the_file_picked_as_it_was() {
        // Discarded while open (failed), and once closed (a muxer closes its
        // file when it's cancelled).
        for closed_first in [false, true] {
            let (folder, film) = folder_with_a_film(&format!("cancel-{closed_first}"));
            let exports = Exports::default();
            exports.add_pick(film.clone());
            let id = exports.open_export(film.clone()).unwrap();
            write(&exports, id, b"half an export");
            if closed_first {
                exports.close(id, true).unwrap();
            }
            exports.close(id, false).unwrap();
            assert_eq!(fs::read(&film).unwrap(), b"the user's film");
            assert_eq!(
                fs::read_dir(&folder).unwrap().count(),
                1,
                "the partial file is gone"
            );
            assert!(exports.commit(id).is_err());
            assert_eq!(fs::read(&film).unwrap(), b"the user's film");
            fs::remove_dir_all(&folder).unwrap();
        }
    }

    #[test]
    fn a_file_in_a_folder_is_kept_where_it_was_written() {
        let (folder, _) = folder_with_a_film("folder");
        let exports = Exports::default();
        let path = folder.join("take.wav");
        let id = exports.begin(Writing {
            path: path.clone(),
            replaces: None,
            file: File::create_new(&path).unwrap(),
            _activity: Activity::begin("Writing a file"),
        });
        write(&exports, id, b"a take");
        exports.close(id, true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a take");
        assert!(lock(&exports.saved).contains(&path));
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_page_gone_leaves_no_export_behind_but_keeps_a_take() {
        let (folder, film) = folder_with_a_film("abandon");
        let exports = Exports::default();
        // An export being written, one finished but not yet put in place, and
        // a take being recorded into a folder.
        let other = folder.join("other.mp4");
        exports.add_pick(film.clone());
        exports.add_pick(other.clone());
        let writing = exports.open_export(film.clone()).unwrap();
        write(&exports, writing, b"half an export");
        let finished = exports.open_export(other.clone()).unwrap();
        write(&exports, finished, b"an export");
        exports.close(finished, true).unwrap();
        let take = folder.join("take.wav");
        let recording = exports.begin(Writing {
            path: take.clone(),
            replaces: None,
            file: File::create_new(&take).unwrap(),
            _activity: Activity::begin("Writing a file"),
        });
        write(&exports, recording, b"a take");
        exports.add_pick(folder.join("unused.mp4"));
        exports.abandon();
        assert_eq!(fs::read(&film).unwrap(), b"the user's film");
        assert!(!other.exists());
        assert_eq!(fs::read(&take).unwrap(), b"a take");
        let mut names: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["film.mp4", "take.wav"],
            "the partial files are gone"
        );
        assert!(lock(&exports.open).is_empty() && lock(&exports.picked).is_empty());
        assert!(exports.commit(finished).is_err());
        fs::remove_dir_all(&folder).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_of_the_apps_own_is_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let folder = std::env::temp_dir().join(format!("magnetcut-own-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        make_own_folder(&folder).unwrap();
        let mode = fs::metadata(&folder).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // Made before, open to others: closed to them.
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o777)).unwrap();
        make_own_folder(&folder).unwrap();
        let mode = fs::metadata(&folder).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // A link in its place, or a file, is refused.
        let link = folder.with_extension("link");
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&folder, &link).unwrap();
        assert!(make_own_folder(&link).is_err());
        let file = folder.join("file");
        File::create(&file).unwrap();
        assert!(make_own_folder(&file).is_err());
        fs::remove_file(&link).unwrap();
        fs::remove_dir_all(&folder).unwrap();
    }

    /// As in the App Store edition, which may write the file picked but not
    /// make another beside it.
    #[cfg(unix)]
    #[test]
    fn where_no_file_can_be_made_beside_it_the_export_is_written_elsewhere() {
        use std::os::unix::fs::PermissionsExt;
        let (folder, film) = folder_with_a_film("locked");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        let exports = Exports::default();
        exports.add_pick(film.clone());
        let opened = exports.open_export(film.clone());
        let partial = opened
            .as_ref()
            .ok()
            .and_then(|id| lock(&exports.open).get(id).map(|w| w.path.clone()));
        let result = opened.and_then(|id| {
            write(&exports, id, b"the export");
            exports.close(id, true)?;
            exports.commit(id)
        });
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        result.unwrap();
        let partial = partial.unwrap();
        assert!(!partial.starts_with(&folder), "{}", partial.display());
        assert!(!partial.exists(), "the copy written elsewhere is gone");
        assert_eq!(fs::read(&film).unwrap(), b"the export");
        fs::remove_dir_all(&folder).unwrap();
    }
}
