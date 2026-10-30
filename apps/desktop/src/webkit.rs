// WebKitGTK, the web view on Linux, keeps some of what the editor needs behind
// feature flags: the Storage API (navigator.storage) and the origin private
// file system behind it, where imported media is kept. They're switched on
// here, through WebKitGTK 2.42's feature API, looked up at run time: on an
// older WebKitGTK the app still starts, without them.

use std::ffi::{CStr, c_char, c_int, c_void};

use serde::Serialize;
use webkit2gtk::WebViewExt;
use webkit2gtk::glib::object::ObjectType;

/// What the editor needs, by WebKit's identifiers (with or without "Enabled").
const NEEDED: &[&str] = &[
    "StorageAPI",
    "StorageAPIEstimate",
    "FileSystem",
    "FileSystemWritableStream",
];

/// WebKitFeatureStatus, in its order.
const STATUS: &[&str] = &[
    "embedder",
    "unstable",
    "internal",
    "developer",
    "testable",
    "preview",
    "stable",
    "mature",
];

/// A feature's state, for the probe.
#[derive(Serialize)]
pub struct Feature {
    id: String,
    status: &'static str,
    default: bool,
    enabled: bool,
}

type List = c_void;
type Item = c_void;

/// The feature API, as WebKitGTK declares it.
struct Api {
    all_features: unsafe extern "C" fn() -> *mut List,
    length: unsafe extern "C" fn(*mut List) -> usize,
    get: unsafe extern "C" fn(*mut List, usize) -> *mut Item,
    unref: unsafe extern "C" fn(*mut List),
    identifier: unsafe extern "C" fn(*mut Item) -> *const c_char,
    status: unsafe extern "C" fn(*mut Item) -> c_int,
    default_value: unsafe extern "C" fn(*mut Item) -> c_int,
    is_enabled: unsafe extern "C" fn(*mut c_void, *mut Item) -> c_int,
    set_enabled: unsafe extern "C" fn(*mut c_void, *mut Item, c_int),
}

impl Api {
    fn load() -> Option<Self> {
        Some(Self {
            all_features: symbol(c"webkit_settings_get_all_features")?,
            length: symbol(c"webkit_feature_list_get_length")?,
            get: symbol(c"webkit_feature_list_get")?,
            unref: symbol(c"webkit_feature_list_unref")?,
            identifier: symbol(c"webkit_feature_get_identifier")?,
            status: symbol(c"webkit_feature_get_status")?,
            default_value: symbol(c"webkit_feature_get_default_value")?,
            is_enabled: symbol(c"webkit_settings_get_feature_enabled")?,
            set_enabled: symbol(c"webkit_settings_set_feature_enabled")?,
        })
    }
}

/// A function of the loaded WebKitGTK, if it has one by that name.
fn symbol<F: Copy>(name: &CStr) -> Option<F> {
    assert_eq!(size_of::<F>(), size_of::<*mut c_void>());
    // SAFETY: dlsym only looks the name up, in the libraries already loaded.
    let address = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    // SAFETY: F is a function pointer type matching the C declaration.
    (!address.is_null()).then(|| unsafe { std::mem::transmute_copy::<*mut c_void, F>(&address) })
}

fn is_needed(id: &str) -> bool {
    NEEDED.contains(&id.strip_suffix("Enabled").unwrap_or(id))
}

/// Switches on what the editor needs in this web view's settings, before its
/// first page loads, and returns every feature's state (for the probe): none
/// on a WebKitGTK without the feature API.
pub fn enable_needed(webview: &webkit2gtk::WebView) -> Vec<Feature> {
    let (Some(api), Some(settings)) = (Api::load(), webview.settings()) else {
        return Vec::new();
    };
    let settings = settings.as_ptr().cast::<c_void>();
    let mut features = Vec::new();
    // SAFETY: the API as declared, on a list it owns until unref, whose items
    // live as long as the list, and on settings the web view holds.
    unsafe {
        let list = (api.all_features)();
        for index in 0..(api.length)(list) {
            let item = (api.get)(list, index);
            let id = CStr::from_ptr((api.identifier)(item))
                .to_string_lossy()
                .into_owned();
            if is_needed(&id) && (api.is_enabled)(settings, item) == 0 {
                (api.set_enabled)(settings, item, 1);
            }
            let status = usize::try_from((api.status)(item)).ok();
            features.push(Feature {
                status: status
                    .and_then(|status| STATUS.get(status))
                    .copied()
                    .unwrap_or("?"),
                default: (api.default_value)(item) != 0,
                enabled: (api.is_enabled)(settings, item) != 0,
                id,
            });
        }
        (api.unref)(list);
    }
    features
}
