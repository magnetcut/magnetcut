// Folders the App Store edition may let agents use (docs/AUTOMATION.md):
// picked once in Settings, kept as security-scoped bookmarks that let the
// app read and write in them again after a relaunch. Elsewhere, nothing's
// needed: the app reaches what the user can.

#[cfg(target_os = "macos")]
mod mac {
    use std::path::{Path, PathBuf};

    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSData, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions,
    };

    /// A bookmark for reading and writing in a folder, for the sandbox.
    pub fn create(path: &Path) -> Option<Vec<u8>> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::WithSecurityScope,
                None,
                None,
            )
            .ok()?;
        Some(data.to_vec())
    }

    /// Where a bookmarked folder is, opened until the app quits.
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

#[cfg(target_os = "macos")]
pub use mac::{create, open};

#[cfg(not(target_os = "macos"))]
pub fn create(_path: &std::path::Path) -> Option<Vec<u8>> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn open(_bookmark: &[u8]) -> Option<std::path::PathBuf> {
    None
}
