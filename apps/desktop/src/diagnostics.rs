//! Native crash reporting. The preference is read before GTK/WebKit starts,
//! including in Sentry's reporter subprocess. No project or media is attached.
//! Opting in later starts reporting at once, except native crash reports: their
//! reporter starts only at launch.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub struct Diagnostics {
    preference: Option<PathBuf>,
    configured: bool,
    /// Started at launch, native crash reports included.
    native: bool,
    /// Started on opting in after launch: errors and panics only.
    late: OnceLock<sentry::ClientInitGuard>,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    decided: bool,
    configured: bool,
    /// Errors are reported in this run.
    active: bool,
    /// Native crashes are too: only after a launch with reporting on.
    native: bool,
}

fn enabled(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|value| value == "enabled\n")
}

/// Explicit test mode allows a local collector with a debug build.
fn test_mode() -> bool {
    std::env::var("MAGNETCUT_SENTRY_TEST").as_deref() == Ok("1")
}

/// What both starts share.
fn options(preference: PathBuf) -> sentry::ClientOptions {
    sentry::ClientOptions::new()
        .dsn(option_env!("MAGNETCUT_SENTRY_DSN").unwrap_or_default())
        .release(
            option_env!("SENTRY_RELEASE")
                .unwrap_or(concat!("magnetcut@", env!("CARGO_PKG_VERSION"))),
        )
        .environment(if test_mode() { "test" } else { "production" })
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
}

impl Diagnostics {
    pub fn new(identifier: &str) -> Self {
        let config = if cfg!(debug_assertions) && test_mode() {
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
            native: false,
            late: OnceLock::new(),
        }
    }

    /// Whether this run may report at all: never the probe, and a debug build
    /// only in the test mode.
    fn allowed(&self) -> bool {
        self.configured
            && (!cfg!(debug_assertions) || test_mode())
            && std::env::var_os("MAGNETCUT_PROBE").is_none()
    }

    pub fn init(&mut self) -> Option<sentry::ClientInitGuard> {
        let reporter =
            sentry::integrations::minidump::MinidumpIntegration::new().is_crash_reporter_process();
        if !self.allowed() || !self.preference.as_deref().is_some_and(enabled) {
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
        let guard = sentry::init(options(preference).add_integration(integration));
        self.native = guard.is_enabled();
        Some(guard)
    }

    /// On opting in after launch: errors, panics and (on Linux) the web
    /// process's crashes are reported from now on. Native crash reports wait
    /// for the next launch, as their reporter must start before GTK/WebKit.
    fn start(&self) {
        if self.native || !self.allowed() {
            return;
        }
        let Some(preference) = self.preference.clone() else {
            return;
        };
        self.late.get_or_init(|| {
            let guard = sentry::init(options(preference));
            // `init` binds this thread's hub, and threads start from the main one.
            sentry::Hub::main().bind_client(sentry::Hub::current().client());
            guard
        });
    }

    fn status(&self) -> Status {
        Status {
            enabled: self.preference.as_deref().is_some_and(enabled),
            decided: self.preference.as_deref().is_some_and(|path| {
                std::fs::read_to_string(path)
                    .is_ok_and(|value| matches!(value.as_str(), "enabled\n" | "disabled\n"))
            }),
            configured: self.configured,
            active: self.native
                || self
                    .late
                    .get()
                    .is_some_and(sentry::ClientInitGuard::is_enabled),
            native: self.native,
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
    if enabled {
        state.start();
    }
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
        let diagnostics = Diagnostics {
            preference: Some(path.clone()),
            configured: true,
            native: false,
            late: OnceLock::new(),
        };
        std::fs::write(&path, "enabled\n").unwrap();
        assert!(enabled(&path));
        assert!(diagnostics.status().decided);
        for value in ["disabled\n", "", "enabled", "invalid"] {
            std::fs::write(&path, value).unwrap();
            assert!(!enabled(&path));
            assert_eq!(diagnostics.status().decided, value == "disabled\n");
        }
        std::fs::remove_file(&path).unwrap();
        assert!(!enabled(&path));
        assert!(!diagnostics.status().decided);
    }
}
