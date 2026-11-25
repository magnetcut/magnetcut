// What an export is asked to make, as the editor says it, and what each
// system's native export can make: the same on every system.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::de::value::{Error as ValueError, StrDeserializer};
use serde::{Deserialize, Deserializer, Serialize};

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
pub struct SubtitleCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A subtitle track, as the editor sends it.
#[derive(Debug, Clone, Deserialize)]
pub struct SubtitleTrack {
    pub cues: Vec<SubtitleCue>,
}

/// One of the film's details, by the editor's name for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileTag {
    Title,
    /// Who made it.
    Artist,
    /// The day it was made, as YYYY-MM-DD.
    Date,
    Genre,
    /// The one detail on several lines.
    Description,
    Comment,
    /// Where it was filmed, in ISO 6709 as cameras write it:
    /// "+48.8584+002.2945+035.000/".
    Location,
    /// The camera's maker and model.
    Make,
    Model,
}

/// The longest a detail is kept, in characters, as the editor keeps them
/// (`MAX_FILE_TAG_LENGTH`): well within the 64 KB a file's tag can hold.
const MAX_TAG_LENGTH: usize = 2000;

/// What the film says of itself, written into its file: the project's
/// details, from the editor's Details panel (apps/web/src/project/
/// file-tags.ts), checked again as they come, as the editor checks them
/// (`FileTags::insert`). One this version doesn't know is left out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileTags(BTreeMap<FileTag, String>);

impl FileTags {
    /// Adds `text` as the `tag`, cleaned: trimmed and at most
    /// `MAX_TAG_LENGTH` long, without control characters, tabs as spaces; a
    /// description's line breaks kept, as "\n", the others' made spaces.
    /// Left out if it's empty then, or a date that's no day, or a place
    /// that's nowhere.
    pub fn insert(&mut self, tag: FileTag, text: &str) {
        let is_multiline = tag == FileTag::Description;
        let spaced = if is_multiline {
            text.replace("\r\n", "\n").replace(['\r'], "\n")
        } else {
            text.replace(['\r', '\n'], " ")
        };
        let cleaned: String = spaced
            .replace('\t', " ")
            .chars()
            .filter(|&character| !character.is_control() || (is_multiline && character == '\n'))
            .collect();
        let text: String = cleaned.trim().chars().take(MAX_TAG_LENGTH).collect();
        let text = text.trim_end();
        let is_valid = !text.is_empty()
            && match tag {
                FileTag::Date => is_day(text),
                FileTag::Location => Place::parse(text).is_some(),
                _ => true,
            };
        if is_valid {
            self.0.insert(tag, text.to_owned());
        }
    }

    pub fn get(&self, tag: FileTag) -> Option<&str> {
        self.0.get(&tag).map(String::as_str)
    }

    /// The details there are, each by what it is.
    pub fn iter(&self) -> impl Iterator<Item = (FileTag, &str)> {
        self.0.iter().map(|(&tag, text)| (tag, text.as_str()))
    }

    /// The day it was made, at noon in UTC, as a date and time: the same
    /// day wherever it's read, and read as a date where a day alone is
    /// misread (AVFoundation takes "2026-11-13" for the year 12181).
    pub fn date_time(&self) -> Option<String> {
        self.get(FileTag::Date)
            .map(|day| format!("{day}T12:00:00Z"))
    }

    /// Where it was filmed.
    pub fn place(&self) -> Option<Place> {
        self.get(FileTag::Location).and_then(Place::parse)
    }
}

impl<'a> FromIterator<(FileTag, &'a str)> for FileTags {
    fn from_iter<I: IntoIterator<Item = (FileTag, &'a str)>>(details: I) -> Self {
        let mut tags = Self::default();
        for (tag, text) in details {
            tags.insert(tag, text);
        }
        tags
    }
}

impl<'de> Deserialize<'de> for FileTags {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let details = BTreeMap::<String, serde_json::Value>::deserialize(deserializer)?;
        let mut tags = Self::default();
        for (name, value) in &details {
            let tag = FileTag::deserialize(StrDeserializer::<ValueError>::new(name));
            if let (Ok(tag), Some(text)) = (tag, value.as_str()) {
                tags.insert(tag, text);
            }
        }
        Ok(tags)
    }
}

/// Whether `text`, YYYY-MM-DD, is a day of the calendar: 2026-02-30 isn't.
fn is_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes[range.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| text[range].parse::<u32>().ok())
            .flatten()
    };
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    let is_leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// A place on Earth, in decimal degrees, and its height in metres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Place {
    pub latitude: f64,
    pub longitude: f64,
    pub height: Option<f64>,
}

impl Place {
    /// A place in ISO 6709 as cameras write it ("+48.8584+002.2945+035.000/"):
    /// each number signed, the slash at the end optional. None for one
    /// that's malformed or off the globe.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_suffix('/').unwrap_or(text);
        let mut numbers = Vec::new();
        let mut start = 0;
        for (index, character) in text.char_indices().skip(1) {
            if character == '+' || character == '-' {
                numbers.push(&text[start..index]);
                start = index;
            }
        }
        numbers.push(&text[start..]);
        let values = numbers
            .iter()
            .map(|number| {
                let digits = number.strip_prefix(['+', '-'])?;
                let (whole, fraction) = digits.split_once('.').unwrap_or((digits, "0"));
                let is_number = !whole.is_empty()
                    && !fraction.is_empty()
                    && whole
                        .bytes()
                        .chain(fraction.bytes())
                        .all(|b| b.is_ascii_digit());
                is_number.then(|| number.parse::<f64>().ok()).flatten()
            })
            .collect::<Option<Vec<f64>>>()?;
        let (latitude, longitude, height) = match values[..] {
            [latitude, longitude] => (latitude, longitude, None),
            [latitude, longitude, height] => (latitude, longitude, Some(height)),
            _ => return None,
        };
        (latitude.abs() <= 90.0 && longitude.abs() <= 180.0).then_some(Self {
            latitude,
            longitude,
            height,
        })
    }
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
    /// Those encoded in hardware, which are fast: the others are encoded in
    /// software, which at 4K can take many times the film's length.
    pub hardware_codecs: Vec<VideoCodec>,
    /// Whether H.264 and HEVC take a constant quality.
    pub constant_quality: bool,
    /// Whether a source's sound can be copied as it's stored.
    pub audio_copy: bool,
    /// Whether subtitle tracks can be written.
    pub subtitle_tracks: bool,
}

// The program that wrote the film, as each file's metadata says it.
pub const WRITING_APP: &str = concat!("MagnetCut ", env!("CARGO_PKG_VERSION"));

// The longest a key frame is from the last, in seconds: a seek within the
// file decodes no more than this.
pub const KEY_FRAME_INTERVAL: f64 = 2.0;

#[cfg(test)]
mod tests {
    use super::{FileTag, FileTags, Place};

    #[test]
    fn details_are_checked_as_they_come() {
        let tags: FileTags = serde_json::from_value(serde_json::json!({
            "title": "  A walk\tby the\nriver\u{7} ",
            "description": "One line\r\nand another\u{0}",
            "date": "2026-02-30",
            "genre": 3,
            "artist": "",
            "location": "+48.8584+002.2945+035.000/",
            "lens": "50 mm",
        }))
        .unwrap();
        assert_eq!(
            tags.iter().collect::<Vec<_>>(),
            [
                (FileTag::Title, "A walk by the river"),
                (FileTag::Description, "One line\nand another"),
                (FileTag::Location, "+48.8584+002.2945+035.000/"),
            ]
        );
        let long = "x".repeat(5000);
        let tags: FileTags = [(FileTag::Comment, long.as_str())].into_iter().collect();
        assert_eq!(tags.get(FileTag::Comment).map(str::len), Some(2000));
    }

    #[test]
    fn a_date_is_a_day_of_the_calendar() {
        let day = |text: &str| {
            [(FileTag::Date, text)]
                .into_iter()
                .collect::<FileTags>()
                .date_time()
        };
        assert_eq!(day("2028-02-29").as_deref(), Some("2028-02-29T12:00:00Z"));
        for wrong in [
            "2026-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-4-1",
            "２０２６-01-01",
        ] {
            assert_eq!(day(wrong), None, "{wrong}");
        }
    }

    #[test]
    fn a_place_is_on_the_globe() {
        assert_eq!(
            Place::parse("+48.8584+002.2945+035.000/"),
            Some(Place {
                latitude: 48.8584,
                longitude: 2.2945,
                height: Some(35.0),
            })
        );
        assert_eq!(
            Place::parse("-33.8568+151.2153"),
            Some(Place {
                latitude: -33.8568,
                longitude: 151.2153,
                height: None,
            })
        );
        for wrong in [
            "+91.0+000.0/",
            "48.8584+002.2945/",
            "+48.+002.2945/",
            "+1e2+000.0/",
            "/",
        ] {
            assert_eq!(Place::parse(wrong), None, "{wrong}");
        }
    }
}
