// An export under way, as the system sees it: on macOS, hidden behind other
// windows, App Nap would slow the app (and the web view's export with it) and
// idle sleep would stop it, as HandBrake keeps them from doing; on Windows,
// sleep would.

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};

/// Keeps the app awake and at speed until dropped.
pub struct Activity {
    #[cfg(target_os = "macos")]
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    /// A power request, set: none if the system wouldn't make one.
    #[cfg(windows)]
    request: Option<HANDLE>,
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
        #[cfg(windows)]
        {
            // Shown by `powercfg /requests`; read as the request's made.
            let mut text: Vec<u16> = reason.encode_utf16().chain([0]).collect();
            let context = REASON_CONTEXT {
                Version: 0,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: windows::core::PWSTR(text.as_mut_ptr()),
                },
            };
            let request = unsafe { PowerCreateRequest(&context) }
                .ok()
                .filter(|&request| {
                    unsafe { PowerSetRequest(request, PowerRequestSystemRequired) }.is_ok()
                });
            Self { request }
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = reason;
            Self {}
        }
    }
}

// SAFETY: the token is only handed back to NSProcessInfo, which takes it on
// any thread; a power request's handle is the process's, not a thread's.
#[cfg(any(target_os = "macos", windows))]
unsafe impl Send for Activity {}

#[cfg(target_os = "macos")]
impl Drop for Activity {
    fn drop(&mut self) {
        unsafe { NSProcessInfo::processInfo().endActivity(&self.token) };
    }
}

#[cfg(windows)]
impl Drop for Activity {
    fn drop(&mut self) {
        if let Some(request) = self.request.take() {
            unsafe {
                let _ = PowerClearRequest(request, PowerRequestSystemRequired);
                let _ = CloseHandle(request);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn begins_and_ends() {
        // Ended as it goes out of scope.
        let _activity = super::Activity::begin("Testing");
    }
}
