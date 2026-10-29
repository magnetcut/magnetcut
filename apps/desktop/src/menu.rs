// The macOS menu bar. Windows and Linux have none: there, the same items are
// in the editor's own menus.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Items the editor handles: a click is sent to it as a `menu` event with
/// the item's id, and it opens its dialog.
pub const ABOUT: &str = "about";
pub const SETTINGS: &str = "settings";
#[cfg(feature = "updater")]
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn is_forwarded(id: &str) -> bool {
    #[cfg(feature = "updater")]
    if id == CHECK_FOR_UPDATES {
        return true;
    }
    id == ABOUT || id == SETTINGS
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = &app.package_info().name;
    let app_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &MenuItem::with_id(app, ABOUT, format!("About {name}"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    #[cfg(feature = "updater")]
    app_menu.insert(
        &MenuItem::with_id(
            app,
            CHECK_FOR_UPDATES,
            "Check for Updates…",
            true,
            None::<&str>,
        )?,
        1,
    )?;

    // Text fields need these for the clipboard; the timeline's own shortcuts
    // reach the page first, as WebKit hands it key equivalents before the menu.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}
