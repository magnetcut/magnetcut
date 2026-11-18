//! GPU acceleration on Linux: hardware video decoding, and WebKit drawing 2D
//! canvases on the GPU. Both are off unless switched on in Settings: with
//! WebKitGTK 2.52 and Intel's driver, a hardware-decoded frame drawn on a
//! canvas crashed the web process (Mesa's glTexSubImage2D, from drawImage of a
//! VideoFrame). The preview's WebGL stays on the GPU either way. The choice is
//! read at launch, before WebKit and its GStreamer start, and applies from the
//! next one.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Where the setting exists.
const SUPPORTED: bool = cfg!(target_os = "linux");

/// GStreamer's VA-API video decoders (Intel, AMD): the va plugin's and the
/// older gstreamer-vaapi's. Ranked out, decodebin and WebKit pick software
/// decoders, in the web view and in the native export alike. The encoders
/// aren't listed: the native export names them itself.
const HARDWARE_DECODERS: &[&str] = &[
    "vah264dec",
    "vah265dec",
    "vavp8dec",
    "vavp9dec",
    "vaav1dec",
    "vampeg2dec",
    "vajpegdec",
    "vavp8alphadecodebin",
    "vavp9alphadecodebin",
    "vaapidecodebin",
    "vaapih264dec",
    "vaapih265dec",
    "vaapivp8dec",
    "vaapivp9dec",
    "vaapiav1dec",
    "vaapimpeg2dec",
    "vaapijpegdec",
];

pub struct Graphics {
    preference: Option<PathBuf>,
    /// This run's: what the preference said at launch.
    accelerated: bool,
}

#[derive(Serialize)]
pub struct Status {
    supported: bool,
    /// The choice saved, for the next launch.
    enabled: bool,
    /// This run's.
    active: bool,
}

fn enabled(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|value| value == "enabled\n")
}

/// GST_PLUGIN_FEATURE_RANK with the hardware decoders ranked out, after what
/// was there: GStreamer applies the list in order, so ours win.
fn ranked_out(existing: Option<&str>) -> String {
    existing
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .into_iter()
        .chain(HARDWARE_DECODERS.iter().map(|name| format!("{name}:NONE")))
        .collect::<Vec<_>>()
        .join(",")
}

impl Graphics {
    pub fn new(identifier: &str) -> Self {
        let preference =
            dirs::config_dir().map(|path| path.join(identifier).join("gpu-acceleration"));
        let accelerated = !SUPPORTED || preference.as_deref().is_some_and(enabled);
        Self {
            preference,
            accelerated,
        }
    }

    /// Whether this run uses the GPU for decoding video and drawing canvases.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn accelerated(&self) -> bool {
        self.accelerated
    }

    /// Without GPU acceleration, ranks the hardware decoders out for this
    /// process and the web process WebKit starts later, which inherits its
    /// environment. First thing in main, before any thread starts. Nothing
    /// off Linux, where acceleration is always on.
    pub fn apply_to_environment(&self) {
        if self.accelerated {
            return;
        }
        let value = ranked_out(std::env::var("GST_PLUGIN_FEATURE_RANK").ok().as_deref());
        // SAFETY: no other thread exists yet to read the environment.
        unsafe { std::env::set_var("GST_PLUGIN_FEATURE_RANK", value) };
    }

    fn status(&self) -> Status {
        Status {
            supported: SUPPORTED,
            enabled: self.preference.as_deref().is_some_and(enabled),
            active: self.accelerated,
        }
    }
}

#[tauri::command]
pub fn gpu_acceleration_status(state: tauri::State<'_, Graphics>) -> Status {
    state.status()
}

#[tauri::command]
pub fn set_gpu_acceleration(
    state: tauri::State<'_, Graphics>,
    enabled: bool,
) -> Result<Status, String> {
    if !SUPPORTED {
        return Err("GPU acceleration is always on here".into());
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_the_decoders_out_after_what_was_there() {
        let alone = ranked_out(None);
        assert!(alone.starts_with("vah264dec:NONE,"));
        assert_eq!(alone.split(',').count(), HARDWARE_DECODERS.len());
        assert_eq!(ranked_out(Some("")), alone);
        assert_eq!(
            ranked_out(Some("avdec_h264:MAX")),
            format!("avdec_h264:MAX,{alone}")
        );
    }

    #[test]
    fn off_unless_enabled() {
        let path = std::env::temp_dir().join(format!("magnetcut-gpu-{}", std::process::id()));
        for (value, on) in [("enabled\n", true), ("disabled\n", false), ("", false)] {
            std::fs::write(&path, value).unwrap();
            assert_eq!(enabled(&path), on);
        }
        std::fs::remove_file(&path).unwrap();
        assert!(!enabled(&path));
    }
}
