// The notification an export's end shows when the window isn't in front
// (apps/web/src/desktop/export-notice.ts). On macOS through Notification
// Center's own framework, UserNotifications, which asks the user the first
// time and works in the App Store's sandbox; elsewhere through notify-rust:
// a toast on Windows, the desktop's notification service on Linux.

/// Shows a notification saying `title` and `body`: none where the system
/// can't show one, as a Mac's app run outside its bundle (in development).
#[tauri::command]
pub async fn show_notice(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    show(&app, &title, &body)
}

#[cfg(target_os = "macos")]
fn show(_app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    macos::show(title, body);
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::Once;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };

    // One at a time in Notification Center: the latest export's end in
    // place of the one before.
    const IDENTIFIER: &str = "export";

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and Presenter
        // has no Drop.
        #[unsafe(super(NSObject))]
        #[name = "MagnetCutNoticePresenter"]
        struct Presenter;

        unsafe impl NSObjectProtocol for Presenter {}

        unsafe impl UNUserNotificationCenterDelegate for Presenter {
            /// Shown while the app is in front too, as when its window is
            /// minimized: macOS would otherwise keep it out of sight.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }
        }
    );

    /// Whether the app runs from its bundle: UserNotifications takes only an
    /// app's, and stops the process otherwise.
    fn is_bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    pub fn show(title: &str, body: &str) {
        if !is_bundled() {
            return;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        static PRESENTER: Once = Once::new();
        PRESENTER.call_once(|| {
            let presenter: Retained<Presenter> =
                unsafe { msg_send![super(Presenter::alloc().set_ivars(())), init] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*presenter)));
            // The center holds its delegate weakly: this one lasts as long as
            // the app.
            std::mem::forget(presenter);
        });
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(
            &objc2_user_notifications::UNNotificationSound::defaultSound(),
        ));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(IDENTIFIER),
            &content,
            None,
        );
        // Asked the first time; then as the user answered, which the system
        // keeps (System Settings, Notifications).
        let post = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            if granted.as_bool() {
                UNUserNotificationCenter::currentNotificationCenter()
                    .addNotificationRequest_withCompletionHandler(&request, None);
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &post,
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn show(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(title);
    #[cfg(windows)]
    {
        notification.body(body);
        // Toasts are the installed app's, by the identifier its Start menu
        // shortcut carries; a build run from target\ has none, and posts as
        // PowerShell does.
        let installed = std::env::current_exe().ok().is_some_and(|exe| {
            !exe.parent().is_some_and(|folder| {
                folder.ends_with("target\\debug") || folder.ends_with("target\\release")
            })
        });
        if installed {
            notification.app_id(&app.config().identifier);
        }
    }
    #[cfg(not(windows))]
    {
        // Notification services that take markup would read it in the text:
        // shown as it's written.
        notification
            .body(&escape_markup(body))
            .appname(&app.package_info().name)
            .auto_icon();
    }
    notification
        .show()
        .map(drop)
        .map_err(|error| error.to_string())
}

/// `text` for a notification body that may be read as markup.
#[cfg(not(any(target_os = "macos", windows)))]
fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(all(test, not(any(target_os = "macos", windows))))]
mod tests {
    #[test]
    fn markup_is_shown_as_written() {
        assert_eq!(
            super::escape_markup("<b>Film</b> & more"),
            "&lt;b&gt;Film&lt;/b&gt; &amp; more"
        );
    }
}
