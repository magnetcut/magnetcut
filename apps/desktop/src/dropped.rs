// The files of the last drop on the web view, where they are: the page sees a
// drop's files only as `File`s, without their paths (dropped_media_files in
// media.rs hands them over, so a dropped video stays where it is rather than
// being copied into the page's storage). They're read from the drop itself,
// as it arrives: the Finder hands a drop over on a pasteboard of its own (seen
// on macOS 27), not on the shared drag pasteboard, which keeps the last drag
// that was made with it. wry's web view hands each drop on to WebKit in its
// performDragOperation: (with dragDropEnabled off, as in tauri.conf.json),
// which is wrapped to note the files first. None off macOS.

use std::path::PathBuf;
use std::sync::Mutex;

/// The files of the last drop, until they're taken.
static LAST_DROP: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// The files of the last drop, once.
pub fn take() -> Vec<PathBuf> {
    std::mem::take(&mut *LAST_DROP.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(target_os = "macos")]
pub use mac::watch;

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, Imp, Sel};
    use objc2::{ClassType, msg_send, sel};
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSURL};

    use super::LAST_DROP;

    /// performDragOperation:, the drop: the web view, the selector and the
    /// NSDraggingInfo.
    type PerformDrag = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;

    /// The web view's own performDragOperation:, which ours calls.
    static ORIGINAL: OnceLock<PerformDrag> = OnceLock::new();

    /// Notes the files of each drop on `webview` (its WKWebView) before WebKit
    /// has the drop. Once: the class's method is wrapped.
    pub fn watch(webview: *mut c_void) {
        // SAFETY: Tauri's with_webview gives the WKWebView, which lives on.
        let Some(webview) = (unsafe { webview.cast::<AnyObject>().as_ref() }) else {
            return;
        };
        let Some(method) = webview.class().instance_method(sel!(performDragOperation:)) else {
            eprintln!("drops: the web view has no performDragOperation:");
            return;
        };
        ORIGINAL.get_or_init(|| {
            let ours: PerformDrag = perform_drag_operation;
            // SAFETY: the method's signature is PerformDrag's, ours as theirs;
            // set on the main thread, where drops arrive, before any.
            unsafe {
                let previous =
                    method.set_implementation(std::mem::transmute::<PerformDrag, Imp>(ours));
                std::mem::transmute::<Imp, PerformDrag>(previous)
            }
        });
    }

    unsafe extern "C-unwind" fn perform_drag_operation(
        this: *mut AnyObject,
        cmd: Sel,
        info: *mut AnyObject,
    ) -> Bool {
        // SAFETY: AppKit passes the NSDraggingInfo of the drop.
        let paths = unsafe { info.as_ref() }
            .map(dropped_paths)
            .unwrap_or_default();
        *LAST_DROP.lock().unwrap_or_else(|e| e.into_inner()) = paths;
        match ORIGINAL.get() {
            // SAFETY: the method this one replaced, with what it was given.
            Some(original) => unsafe { original(this, cmd, info) },
            None => Bool::NO,
        }
    }

    /// The files on a drop's pasteboard.
    fn dropped_paths(info: &AnyObject) -> Vec<PathBuf> {
        // SAFETY: draggingPasteboard is NSDraggingInfo's.
        let pasteboard: Option<Retained<NSPasteboard>> =
            unsafe { msg_send![info, draggingPasteboard] };
        let Some(pasteboard) = pasteboard else {
            return Vec::new();
        };
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let Some(items) = (unsafe { pasteboard.readObjectsForClasses_options(&classes, None) })
        else {
            return Vec::new();
        };
        items
            .iter()
            .filter_map(|item| {
                let url = item.downcast_ref::<NSURL>()?;
                // A file reference URL (file:///.file/id=...) as a path; none
                // for a URL that isn't a file's.
                Some(PathBuf::from(url.filePathURL()?.path()?.to_string()))
            })
            .collect()
    }
}
