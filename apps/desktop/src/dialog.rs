// The open and save dialogs show the files their filter's extensions name.
// macOS and Windows match those whatever their case; GTK, on Linux and the
// BSDs, matches its patterns ("*.mp4") exactly, and so hid "CLIP.MP4". There,
// each letter is given as both ("[mM][pP]4"), a pattern GTK reads as a glob.

use tauri::Runtime;
use tauri_plugin_dialog::FileDialogBuilder;

pub trait AnyCaseFilter {
    /// `add_filter`, for files with these extensions in any case.
    fn add_any_case_filter(self, name: &str, extensions: &[&str]) -> Self;
}

impl<R: Runtime> AnyCaseFilter for FileDialogBuilder<R> {
    fn add_any_case_filter(self, name: &str, extensions: &[&str]) -> Self {
        let patterns = filter_extensions(extensions);
        let patterns: Vec<&str> = patterns.iter().map(String::as_str).collect();
        self.add_filter(name, &patterns)
    }
}

/// The extensions as this system's dialogs are to match them.
fn filter_extensions(extensions: &[&str]) -> Vec<String> {
    let exact = cfg!(any(target_os = "macos", windows));
    extensions
        .iter()
        .map(|extension| {
            if exact {
                (*extension).to_owned()
            } else {
                either_case(extension)
            }
        })
        .collect()
}

/// "mp4" as "[mM][pP]4".
fn either_case(extension: &str) -> String {
    extension
        .chars()
        .map(|c| match (c.to_ascii_lowercase(), c.to_ascii_uppercase()) {
            (lower, upper) if lower != upper => format!("[{lower}{upper}]"),
            _ => c.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_match_either_case() {
        assert_eq!(either_case("mp4"), "[mM][pP]4");
        assert_eq!(either_case("3gp"), "3[gG][pP]");
        assert_eq!(either_case("M2TS"), "[mM]2[tT][sS]");
    }

    #[test]
    fn as_the_system_matches() {
        let extensions = filter_extensions(&["mp4", "jpeg"]);
        if cfg!(any(target_os = "macos", windows)) {
            assert_eq!(extensions, ["mp4", "jpeg"]);
        } else {
            assert_eq!(extensions, ["[mM][pP]4", "[jJ][pP][eE][gG]"]);
        }
    }
}
