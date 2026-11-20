// How much of the computer an export takes: the export panel's Priority, one
// for every export being made, which can change while they run: each takes
// a new one at its next frame. Each system's way: on a Mac, the quality of
// service of the export's own threads, its own and the AV1 encoder's
// (av1.rs), the one encoder that works on the processor (the others are the
// media engine's); on Windows, the app's priority class, which Media
// Foundation's threads have too. Not on Linux, where an app may lower a
// thread's priority but not raise it again, and the encoders' threads are
// GStreamer's.

use std::sync::atomic::{AtomicU8, Ordering};

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    /// As fast as it can: work the user waits for.
    #[default]
    Normal,
    /// Giving way to whatever else the computer is doing.
    Low,
    /// Only with time to spare: much slower (on a Mac, on its efficiency
    /// cores alone).
    Background,
}

/// Whether exports take a priority here, and a new one while they run.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// The priority asked for last.
static WANTED: AtomicU8 = AtomicU8::new(Priority::Normal as u8);

/// The priority exports are to run at.
pub fn wanted() -> Priority {
    match WANTED.load(Ordering::Relaxed) {
        1 => Priority::Low,
        2 => Priority::Background,
        _ => Priority::Normal,
    }
}

/// Runs the exports being made, and those to come, at `priority`.
pub fn set_wanted(priority: Priority) {
    WANTED.store(priority as u8, Ordering::Relaxed);
}

/// An export's thread, kept at the priority asked for.
pub struct ExportThread {
    applied: Option<Priority>,
}

impl ExportThread {
    /// On the export's thread, as it starts: before its encoder, whose
    /// threads start at it.
    pub fn start() -> Self {
        #[cfg(windows)]
        process_class::begin();
        let mut thread = Self { applied: None };
        thread.follow();
        thread
    }

    /// Takes the priority asked for, if it's changed.
    pub fn follow(&mut self) {
        let wanted = wanted();
        if self.applied == Some(wanted) {
            return;
        }
        self.applied = Some(wanted);
        #[cfg(target_os = "macos")]
        set_this_thread(wanted);
        #[cfg(windows)]
        process_class::set(wanted);
    }
}

#[cfg(windows)]
impl Drop for ExportThread {
    fn drop(&mut self) {
        process_class::end();
    }
}

/// Puts the calling thread, one of an export's own, at `priority`.
#[cfg(target_os = "macos")]
pub fn set_this_thread(priority: Priority) {
    use libc::qos_class_t::{QOS_CLASS_BACKGROUND, QOS_CLASS_USER_INITIATED, QOS_CLASS_UTILITY};

    let class = match priority {
        Priority::Normal => QOS_CLASS_USER_INITIATED,
        Priority::Low => QOS_CLASS_UTILITY,
        Priority::Background => QOS_CLASS_BACKGROUND,
    };
    // SAFETY: sets the calling thread's own class.
    let error = unsafe { libc::pthread_set_qos_class_self_np(class, 0) };
    if error != 0 {
        eprintln!(
            "export priority: {}",
            std::io::Error::from_raw_os_error(error)
        );
    }
}

/// The app's priority class: the one asked for while an export runs, normal
/// again once none does.
#[cfg(windows)]
mod process_class {
    use std::sync::Mutex;

    use windows::Win32::System::Threading::{
        BELOW_NORMAL_PRIORITY_CLASS, GetCurrentProcess, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        SetPriorityClass,
    };

    use super::Priority;

    /// How many exports are running: the class is set and put back under it.
    static RUNNING: Mutex<usize> = Mutex::new(0);

    pub fn begin() {
        *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    }

    pub fn set(priority: Priority) {
        let running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if *running > 0 {
            apply(priority);
        }
    }

    pub fn end() {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        *running = running.saturating_sub(1);
        if *running == 0 {
            apply(Priority::Normal);
        }
    }

    fn apply(priority: Priority) {
        let class = match priority {
            Priority::Normal => NORMAL_PRIORITY_CLASS,
            Priority::Low => BELOW_NORMAL_PRIORITY_CLASS,
            Priority::Background => IDLE_PRIORITY_CLASS,
        };
        // SAFETY: this process's pseudo-handle, which needs no closing.
        if let Err(error) = unsafe { SetPriorityClass(GetCurrentProcess(), class) } {
            eprintln!("export priority: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_as_the_page_names_them() {
        let parsed: Vec<Priority> =
            serde_json::from_str(r#"["normal", "low", "background"]"#).unwrap();
        assert_eq!(
            parsed,
            [Priority::Normal, Priority::Low, Priority::Background]
        );
    }

    /// A thread's class goes down and comes back up, as the export's do
    /// while it runs.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_thread_goes_down_and_back_up() {
        use libc::qos_class_t::{
            QOS_CLASS_BACKGROUND, QOS_CLASS_USER_INITIATED, QOS_CLASS_UTILITY,
        };

        fn class() -> libc::qos_class_t {
            let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
            let mut relative = 0;
            // SAFETY: this thread's own class, into these.
            unsafe {
                libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative)
            };
            class
        }

        std::thread::spawn(|| {
            for (priority, expected) in [
                (Priority::Background, QOS_CLASS_BACKGROUND),
                (Priority::Low, QOS_CLASS_UTILITY),
                (Priority::Normal, QOS_CLASS_USER_INITIATED),
            ] {
                set_this_thread(priority);
                assert_eq!(class() as u32, expected as u32, "{priority:?}");
            }
        })
        .join()
        .unwrap();
    }
}
