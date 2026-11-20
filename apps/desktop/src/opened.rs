// Videos and projects opened with MagnetCut: from the Finder (Open With for a
// video; a double click for a .magnetcut, which is MagnetCut's own), a file
// manager or Explorer (the types are in tauri.conf.json and its macOS and
// Linux versions), or named on the command line. Kept until the page takes
// them (take_opened_files): a video goes into the open project's media or,
// with none open (as when MagnetCut starts with it), into a new project of its
// own; a project file is opened as a project of its own, as by File, Open
// Project… (apps/web/src/desktop/opened-files.ts). On macOS they come as the
// app's open event; elsewhere as this copy's arguments, or those of one
// started while it's open, which hands them over (the single-instance
// plugin).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::media::{self, DiskFileInfo, MediaFiles};
use crate::project_file::{self, Picked};

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

/// Whether MagnetCut opens a file: a medium or a project file.
fn opens(path: &Path) -> bool {
    media::is_media(path) || project_file::is_project_file(path)
}

/// The media and project files a command line names, from `cwd` when
/// relative: its program, its options and anything else left out.
pub fn paths_in_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .filter(|path| opens(path) && path.is_file())
        .collect()
}

/// What was opened with MagnetCut since the page last asked.
#[derive(Serialize)]
pub struct Opened {
    /// Media, which the editor may read from now on.
    media: Vec<DiskFileInfo>,
    /// Project files, the media in them opened for the editor.
    projects: Vec<Picked>,
    /// Project files that couldn't be read: which, and why.
    unreadable: Vec<String>,
}

#[tauri::command]
pub fn take_opened_files(opened: State<'_, OpenedFiles>, media: State<'_, MediaFiles>) -> Opened {
    let paths = std::mem::take(&mut *opened.pending.lock().unwrap_or_else(|e| e.into_inner()));
    let (projects, files): (Vec<PathBuf>, Vec<PathBuf>) = paths
        .into_iter()
        .partition(|path| project_file::is_project_file(path));
    let mut taken = Opened {
        media: media.grant(files),
        projects: Vec::new(),
        unreadable: Vec::new(),
    };
    for path in projects {
        match project_file::read_project(&path, &media) {
            Ok(project) => taken.projects.push(project),
            Err(error) => taken
                .unreadable
                .push(format!("{}: {error}", path.display())),
        }
    }
    taken
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_line_names_its_media_and_project_files() {
        let folder = tempfile::tempdir().unwrap();
        for name in ["Trip.MP4", "notes.txt", "Cut.MAGNETCUT"] {
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
            "Cut.MAGNETCUT",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            paths_in_args(&args, folder.path()),
            [
                folder.path().join("Trip.MP4"),
                absolute,
                folder.path().join("Cut.MAGNETCUT")
            ]
        );
        // The program alone, as most starts are.
        assert!(paths_in_args(&args[..1], folder.path()).is_empty());
    }
}
