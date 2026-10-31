// What an export is asked to make, as the editor says it, and what each
// system's native export can make: the same on every system.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mov,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoCodec {
    Avc,
    Hevc,
    #[serde(rename = "prores")]
    ProRes,
    #[serde(rename = "prores-hq")]
    ProResHq,
    /// In software, by rav1e (`av1.rs`).
    Av1,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

pub struct VideoSettings {
    pub codec: VideoCodec,
    pub width: u32,
    pub height: u32,
    /// In bits a second; ProRes has none, its rate is the codec's.
    pub bitrate: u32,
    /// Constant quality instead of a bitrate, from 0 to 1, where the
    /// encoder takes one (`Capabilities`): only the Mac's, so far.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub quality: Option<f32>,
    pub fps: FrameRate,
}

/// AAC, from the mix the editor makes.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub channels: u32,
    pub sample_rate: u32,
    /// In bits a second.
    pub bitrate: u32,
}

/// The film's sound.
pub enum Audio {
    /// AAC, from the mix the editor sends.
    Mix(AudioSettings),
    /// A file's sound as it's stored, up to `end` seconds: the source's
    /// when the timeline plays it uncut.
    Copy { location: PathBuf, end: f64 },
}

/// A line of a subtitle track, in seconds.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(windows, allow(dead_code))]
pub struct SubtitleCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A subtitle track, as the editor sends it: written on a Mac and on Linux,
/// so far.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(windows, allow(dead_code))]
pub struct SubtitleTrack {
    pub cues: Vec<SubtitleCue>,
}

/// A source's picture as the editor shows it: turned as the file says.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    /// Clockwise, in degrees: 0, 90, 180 or 270.
    pub rotation: u32,
}

/// What the native export can make on this computer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub formats: Vec<Container>,
    pub video_codecs: Vec<VideoCodec>,
    /// Whether H.264 and HEVC take a constant quality.
    pub constant_quality: bool,
    /// Whether a source's sound can be copied as it's stored.
    pub audio_copy: bool,
    /// Whether subtitle tracks can be written.
    pub subtitle_tracks: bool,
}

// The longest a key frame is from the last, in seconds: a seek within the
// file decodes no more than this.
pub const KEY_FRAME_INTERVAL: f64 = 2.0;
