// Media files read where they are, instead of copied into the web view's
// storage (docs/NATIVE.md, phase 1). The editor reads a file by its path, and
// only a file the user gave it: picked in the open dialog or dropped on the
// window. Those are kept between launches; on macOS with a bookmark, which the
// App Store sandbox needs to open a file again, and which follows a file that
// has been moved or renamed.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The most one read returns: the editor reads in pieces.
const MAX_READ: u64 = 64 << 20;

/// What the open dialog offers: what the editor imports.
const EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "mts", "m2ts", "ts", "3gp", "mp3", "m4a", "aac",
    "wav", "flac", "ogg", "oga", "opus", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg",
];

/// A file as the editor sees it, as a `File` would describe it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskFileInfo {
    /// The path the editor knows it by, which stays the same if it moves.
    path: String,
    name: String,
    size: u64,
    /// Milliseconds since 1970, as `File.lastModified`.
    last_modified: f64,
}

#[derive(Serialize, Deserialize)]
struct SavedFile {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bookmark: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    files: Vec<SavedFile>,
}

struct Entry {
    bookmark: Option<String>,
    /// Where it is now: the path, or where its bookmark leads.
    location: PathBuf,
}

/// The files the user has given the editor, by the path it knows them by.
pub struct MediaFiles {
    saved: PathBuf,
    entries: Mutex<HashMap<String, Entry>>,
    /// The drag whose files were last handed over (the drag pasteboard's
    /// change count): each drag's, once.
    last_drop: Mutex<Option<isize>>,
}

impl MediaFiles {
    pub fn load(app: &AppHandle) -> Self {
        let saved = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("media-files.json");
        let files = fs::read(&saved)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
            .unwrap_or_default()
            .files;
        let entries = files
            .into_iter()
            .map(|file| {
                let location = file
                    .bookmark
                    .as_deref()
                    .and_then(|bookmark| BASE64.decode(bookmark).ok())
                    .and_then(|bookmark| bookmarks::open(&bookmark))
                    .unwrap_or_else(|| PathBuf::from(&file.path));
                let entry = Entry {
                    bookmark: file.bookmark,
                    location,
                };
                (file.path, entry)
            })
            .collect();
        Self {
            saved,
            entries: Mutex::new(entries),
            last_drop: Mutex::new(None),
        }
    }

    /// Lets the editor read these files from now on: media files only.
    fn grant(&self, paths: Vec<PathBuf>) -> Vec<DiskFileInfo> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut infos = Vec::new();
        for location in paths.into_iter().filter(|path| is_media(path)) {
            let Some(path) = location.to_str().map(str::to_owned) else {
                continue;
            };
            let Some(info) = describe(&path, &location) else {
                continue;
            };
            let bookmark = bookmarks::create(&location).map(|bookmark| BASE64.encode(bookmark));
            entries.insert(path, Entry { bookmark, location });
            infos.push(info);
        }
        self.save(&entries);
        infos
    }

    fn save(&self, entries: &HashMap<String, Entry>) {
        let saved = Saved {
            files: entries
                .iter()
                .map(|(path, entry)| SavedFile {
                    path: path.clone(),
                    bookmark: entry.bookmark.clone(),
                })
                .collect(),
        };
        let written = self
            .saved
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| fs::write(&self.saved, serde_json::to_vec(&saved).unwrap_or_default()));
        if let Err(error) = written {
            eprintln!("media files: can't save {}: {error}", self.saved.display());
        }
    }

    fn location(&self, path: &str) -> Option<PathBuf> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.get(path).map(|entry| entry.location.clone())
    }
}

fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

fn describe(path: &str, location: &Path) -> Option<DiskFileInfo> {
    let metadata = fs::metadata(location)
        .ok()
        .filter(|metadata| metadata.is_file())?;
    let last_modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |since| since.as_millis() as f64);
    Some(DiskFileInfo {
        path: path.to_owned(),
        name: location.file_name()?.to_string_lossy().into_owned(),
        size: metadata.len(),
        last_modified,
    })
}

/// The open dialog, for media to import.
#[tauri::command]
pub async fn pick_media_files(
    app: AppHandle,
    media: State<'_, MediaFiles>,
) -> Result<Vec<DiskFileInfo>, String> {
    let mut dialog = app.dialog().file().add_filter("Media", EXTENSIONS);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
        .await
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let paths = picked
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect();
    Ok(media.grant(paths))
}

/// The files of the drop the page has just received, which it only sees as
/// `File`s: their paths are on the drag pasteboard. Each drag's once, since the
/// pasteboard keeps the last drag made anywhere. None off macOS.
#[tauri::command]
pub fn dropped_media_files(media: State<'_, MediaFiles>) -> Vec<DiskFileInfo> {
    let Some((drag, paths)) = drag_paths() else {
        return Vec::new();
    };
    let mut last_drop = media.last_drop.lock().unwrap_or_else(|e| e.into_inner());
    if *last_drop == Some(drag) {
        return Vec::new();
    }
    *last_drop = Some(drag);
    drop(last_drop);
    media.grant(paths)
}

/// A file the editor was given before, as it is now; none if it's gone.
#[tauri::command]
pub fn media_file_info(media: State<'_, MediaFiles>, path: String) -> Option<DiskFileInfo> {
    describe(&path, &media.location(&path)?)
}

/// Bytes `start..end` of a file the editor was given (fewer at its end).
#[tauri::command]
pub fn read_media_file(
    media: State<'_, MediaFiles>,
    path: String,
    start: u64,
    end: u64,
) -> Result<Response, String> {
    let location = media
        .location(&path)
        .ok_or("not a file MagnetCut was given")?;
    if end < start || end - start > MAX_READ {
        return Err(format!("can't read {start}..{end} at once"));
    }
    let mut file = File::open(&location).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity((end - start) as usize);
    file.take(end - start)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

/// The files on the drag pasteboard, and which drag put them there.
#[cfg(target_os = "macos")]
fn drag_paths() -> Option<(isize, Vec<PathBuf>)> {
    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSURL};

    let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let items = unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }?;
    let paths = items
        .iter()
        .filter_map(|item| {
            let url = item.downcast_ref::<NSURL>()?;
            // A file reference URL (file:///.file/id=...) as a path.
            Some(PathBuf::from(url.filePathURL()?.path()?.to_string()))
        })
        .collect();
    Some((pasteboard.changeCount(), paths))
}

#[cfg(not(target_os = "macos"))]
fn drag_paths() -> Option<(isize, Vec<PathBuf>)> {
    None
}

#[cfg(target_os = "macos")]
mod bookmarks {
    use std::path::{Path, PathBuf};

    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSData, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions,
    };

    /// A bookmark for reading the file, security-scoped for the sandbox.
    pub fn create(path: &Path) -> Option<Vec<u8>> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let options = NSURLBookmarkCreationOptions::WithSecurityScope
            | NSURLBookmarkCreationOptions::SecurityScopeAllowOnlyReadAccess;
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                options, None, None,
            )
            .ok()?;
        Some(data.to_vec())
    }

    /// Where the bookmarked file is now, opened for reading until the app quits.
    pub fn open(bookmark: &[u8]) -> Option<PathBuf> {
        let data = NSData::with_bytes(bookmark);
        let mut stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .ok()?;
        unsafe { url.startAccessingSecurityScopedResource() };
        Some(PathBuf::from(url.path()?.to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
mod bookmarks {
    use std::path::{Path, PathBuf};

    pub fn create(_path: &Path) -> Option<Vec<u8>> {
        None
    }

    pub fn open(_bookmark: &[u8]) -> Option<PathBuf> {
        None
    }
}
