//! Native crash reporting. The preference is read before GTK/WebKit starts,
//! including in Sentry's reporter subprocess. No project or media is attached.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub struct Diagnostics {
    preference: Option<PathBuf>,
    configured: bool,
    active: bool,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    configured: bool,
    active: bool,
}

fn enabled(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|value| value == "enabled\n")
}

impl Diagnostics {
    pub fn new(identifier: &str) -> Self {
        let config = if cfg!(debug_assertions)
            && std::env::var("MAGNETCUT_SENTRY_TEST").as_deref() == Ok("1")
        {
            std::env::var_os("MAGNETCUT_SENTRY_TEST_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(dirs::config_dir)
        } else {
            dirs::config_dir()
        };
        let preference = config.map(|path| path.join(identifier).join("crash-reporting"));
        let configured = preference.is_some()
            && option_env!("MAGNETCUT_SENTRY_DSN").is_some_and(|dsn| !dsn.is_empty());
        Self {
            preference,
            configured,
            active: false,
        }
    }

    pub fn init(&mut self) -> Option<sentry::ClientInitGuard> {
        let reporter =
            sentry::integrations::minidump::MinidumpIntegration::new().is_crash_reporter_process();
        // Explicit test mode allows a local collector with a debug build.
        let test = std::env::var("MAGNETCUT_SENTRY_TEST").as_deref() == Ok("1");
        if !self.configured
            || !self.preference.as_deref().is_some_and(enabled)
            || (cfg!(debug_assertions) && !test)
            || std::env::var_os("MAGNETCUT_PROBE").is_some()
        {
            // Consent may change between spawning and starting the reporter.
            // It must never fall through and open a second editor window.
            if reporter {
                std::process::exit(0);
            }
            return None;
        }
        let preference = self.preference.clone()?;
        let dumps = preference.parent()?.join("crashes");
        let integration = sentry::integrations::minidump::MinidumpIntegration::new()
            .crashes_dir(dumps)
            .inherit_args(false);
        let options = sentry::ClientOptions::new()
            .dsn(option_env!("MAGNETCUT_SENTRY_DSN").unwrap_or_default())
            .release(
                option_env!("SENTRY_RELEASE")
                    .unwrap_or(concat!("magnetcut@", env!("CARGO_PKG_VERSION"))),
            )
            .environment(if test { "test" } else { "production" })
            .send_default_pii(false)
            .traces_sample_rate(0.0)
            .max_breadcrumbs(30)
            .before_send(move |mut event| {
                // Also runs in the reporter: turning reporting off stops new
                // uploads immediately, without reinitializing signal handlers.
                if !enabled(&preference) {
                    return None;
                }
                event.server_name = None;
                event.user = None;
                Some(event)
            })
            .add_integration(integration);
        let guard = sentry::init(options);
        self.active = guard.is_enabled();
        Some(guard)
    }

    fn status(&self) -> Status {
        Status {
            enabled: self.preference.as_deref().is_some_and(enabled),
            configured: self.configured,
            active: self.active,
        }
    }
}

#[tauri::command]
pub fn crash_reporting_status(state: tauri::State<'_, Diagnostics>) -> Status {
    state.status()
}

#[tauri::command]
pub fn set_crash_reporting(
    state: tauri::State<'_, Diagnostics>,
    enabled: bool,
) -> Result<Status, String> {
    let preference = state
        .preference
        .as_ref()
        .ok_or("No configuration directory")?;
    let parent = preference.parent().ok_or("No configuration directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    std::fs::write(preference, if enabled { "enabled\n" } else { "disabled\n" })
        .map_err(|error| error.to_string())?;
    Ok(state.status())
}

#[cfg(target_os = "linux")]
pub fn web_process_terminated(reason: webkit2gtk::WebProcessTerminationReason) {
    use webkit2gtk::WebProcessTerminationReason;
    let kind = match reason {
        WebProcessTerminationReason::Crashed => "crashed",
        WebProcessTerminationReason::ExceededMemoryLimit => "memory-limit",
        _ => return,
    };
    eprintln!("WebKit web process terminated: {kind}");
    sentry::with_scope(
        |scope| {
            scope.set_tag("process", "webkit");
            scope.set_tag("termination_reason", kind);
        },
        || {
            sentry::capture_message("WebKit web process terminated", sentry::Level::Error);
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_fails_closed() {
        let path = std::env::temp_dir().join(format!("magnetcut-consent-{}", std::process::id()));
        std::fs::write(&path, "enabled\n").unwrap();
        assert!(enabled(&path));
        for value in ["disabled\n", "", "enabled", "invalid"] {
            std::fs::write(&path, value).unwrap();
            assert!(!enabled(&path));
        }
        std::fs::remove_file(&path).unwrap();
        assert!(!enabled(&path));
    }
}
