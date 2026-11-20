// Videos opened with MagnetCut: from the Finder's Open With, a file manager's
// on Linux (the types are in tauri.macos.conf.json and tauri.linux.conf.json),
// or named on the command line. Kept until the page takes them
// (take_opened_files), which puts them in the open project's media or, with
// none open (as when MagnetCut starts with them), in a new project of their
// own (apps/web/src/desktop/opened-files.ts). On macOS they come as the app's
// open event; elsewhere as this copy's arguments, or those of one started
// while it's open, which hands them over (the single-instance plugin).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::media::{self, DiskFileInfo, MediaFiles};

/// What the page is told when files arrive while it's open.
const EVENT: &str = "files-opened";

pub struct OpenedFiles {
    pending: Mutex<Vec<PathBuf>>,
}

impl OpenedFiles {
    /// With the files this copy was started with.
    pub fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            pending: Mutex::new(paths),
        }
    }

    /// Files opened with MagnetCut while it runs: kept, and the page told.
    pub fn receive(&self, app: &AppHandle, paths: Vec<PathBuf>) {
        let paths: Vec<PathBuf> = paths.into_iter().filter(|path| opens(path)).collect();
        if paths.is_empty() {
            return;
        }
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(paths);
        if let Err(error) = app.emit_to("main", EVENT, ()) {
            eprintln!("opened files: {error}");
        }
    }
}

/// Whether MagnetCut opens a file.
fn opens(path: &Path) -> bool {
    media::is_media(path)
}

/// The media files a command line names, from `cwd` when relative: its
/// program, its options and anything else left out.
pub fn paths_in_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .filter(|path| opens(path) && path.is_file())
        .collect()
}

/// The files opened with MagnetCut since the page last asked, which the
/// editor may read from now on.
#[tauri::command]
pub fn take_opened_files(
    opened: State<'_, OpenedFiles>,
    media: State<'_, MediaFiles>,
) -> Vec<DiskFileInfo> {
    let paths = std::mem::take(&mut *opened.pending.lock().unwrap_or_else(|e| e.into_inner()));
    media.grant(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_line_names_its_media_files() {
        let folder = tempfile::tempdir().unwrap();
        for name in ["Trip.MP4", "notes.txt"] {
            std::fs::write(folder.path().join(name), b"").unwrap();
        }
        let elsewhere = tempfile::tempdir().unwrap();
        let absolute = elsewhere.path().join("clip.mov");
        std::fs::write(&absolute, b"").unwrap();
        let args: Vec<String> = [
            "magnetcut",
            "--hidden",
            "Trip.MP4",
            "notes.txt",
            "missing.mov",
            absolute.to_str().unwrap(),
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            paths_in_args(&args, folder.path()),
            [folder.path().join("Trip.MP4"), absolute]
        );
        // The program alone, as most starts are.
        assert!(paths_in_args(&args[..1], folder.path()).is_empty());
    }
}
