// An export under way, as the system sees it: on macOS, hidden behind other
// windows, App Nap would slow the app (and the web view's export with it) and
// idle sleep would stop it, as HandBrake keeps them from doing.

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

/// Keeps the app awake and at speed until dropped.
pub struct Activity {
    #[cfg(target_os = "macos")]
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

impl Activity {
    pub fn begin(reason: &str) -> Self {
        #[cfg(target_os = "macos")]
        {
            let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiated,
                &NSString::from_str(reason),
            );
            Self { token }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = reason;
            Self {}
        }
    }
}

// SAFETY: the token is only handed back to NSProcessInfo, which takes it on
// any thread.
#[cfg(target_os = "macos")]
unsafe impl Send for Activity {}

#[cfg(target_os = "macos")]
impl Drop for Activity {
    fn drop(&mut self) {
        unsafe { NSProcessInfo::processInfo().endActivity(&self.token) };
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn begins_and_ends() {
        drop(super::Activity::begin("Testing"));
    }
}
