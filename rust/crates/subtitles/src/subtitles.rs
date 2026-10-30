//! Subtitles as files have them (SRT, WebVTT, ASS/SSA, SubViewer, MicroDVD),
//! read into one model and written back (docs/PLAN.md, step 10). Written anew:
//! none of Jubler's code, which is GPL.

pub mod align;
mod ass;
mod encoding;
mod markup;
mod microdvd;
mod srt;
mod subviewer;
mod times;
pub mod timing;
mod vtt;

use serde::{Deserialize, Serialize};

pub use ass::{AssScript, AssStyle};

/// A subtitle: when it shows, in seconds, and what it says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    /// Its lines, joined by "\n". The only markup kept is `<i>`, `<b>` and
    /// `<u>`, which every format has a way to say.
    pub text: String,
    /// The ASS style it's in, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Srt,
    Vtt,
    Ass,
    Ssa,
    SubViewer,
    MicroDvd,
}

impl Format {
    /// The file name extension it's saved with.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::Ass => "ass",
            Self::Ssa => "ssa",
            Self::SubViewer => "sub",
            Self::MicroDvd => "sub",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtitles {
    pub cues: Vec<Cue>,
    /// An ASS or SSA file's header and styles, to write it back as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ass: Option<AssScript>,
}

/// A file opened: what was in it, and what was made of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub subtitles: Subtitles,
    pub format: Format,
    /// The text encoding found, as the WHATWG names it ("UTF-8", "windows-1252").
    pub encoding: String,
    /// Lines that couldn't be read, skipped.
    pub skipped: usize,
    pub warnings: Vec<String>,
}

/// What a format's reader makes of a file's text.
#[derive(Debug, Default)]
struct Parsed {
    cues: Vec<Cue>,
    ass: Option<AssScript>,
    skipped: usize,
    warnings: Vec<String>,
}

/// Opens a subtitle file: its encoding and format found, from its content
/// and then its name. MicroDVD counts frames: at `frame_rate`, unless the
/// file says, else 23.976.
pub fn open(bytes: &[u8], name: Option<&str>, frame_rate: Option<f64>) -> Result<Opened, String> {
    let (text, encoding) = encoding::decode(bytes);
    let format = detect(&text, name).ok_or("This isn't a subtitle file MagnetCut knows")?;
    let mut parsed = match format {
        Format::Srt => srt::read(&text),
        Format::Vtt => vtt::read(&text),
        Format::Ass | Format::Ssa => ass::read(&text),
        Format::SubViewer => subviewer::read(&text),
        Format::MicroDvd => microdvd::read(&text, frame_rate),
    };
    if parsed.cues.is_empty() {
        return Err("There are no subtitles in this file".into());
    }
    parsed.cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    Ok(Opened {
        subtitles: Subtitles {
            cues: parsed.cues,
            ass: parsed.ass,
        },
        format,
        encoding: encoding.to_owned(),
        skipped: parsed.skipped,
        warnings: parsed.warnings,
    })
}

/// The format of a file's text: by what's in it, then by its name.
pub fn detect(text: &str, name: Option<&str>) -> Option<Format> {
    let start = text.trim_start_matches('\u{feff}').trim_start();
    let first_line = start.lines().next().unwrap_or("");
    if first_line.starts_with("WEBVTT") {
        return Some(Format::Vtt);
    }
    if start.len() >= 13 && start[..13].eq_ignore_ascii_case("[script info]") {
        let is_ssa = text.lines().any(|line| {
            let line = line.trim();
            line.eq_ignore_ascii_case("[v4 styles]")
                || line.eq_ignore_ascii_case("scripttype: v4.00")
        });
        return Some(if is_ssa { Format::Ssa } else { Format::Ass });
    }
    if microdvd::is_cue(first_line) {
        return Some(Format::MicroDvd);
    }
    if first_line.eq_ignore_ascii_case("[information]") || subviewer::starts(start) {
        return Some(Format::SubViewer);
    }
    if start.lines().take(8).any(srt::is_timing) {
        return Some(Format::Srt);
    }
    let extension = name?.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "srt" => Some(Format::Srt),
        "vtt" => Some(Format::Vtt),
        "ass" => Some(Format::Ass),
        "ssa" => Some(Format::Ssa),
        _ => None,
    }
}

/// The subtitles as a file of `format`, in UTF-8. MicroDVD needs the frame
/// rate its frames count at.
pub fn save(
    subtitles: &Subtitles,
    format: Format,
    frame_rate: Option<f64>,
) -> Result<String, String> {
    let mut cues = subtitles.cues.clone();
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    Ok(match format {
        Format::Srt => srt::write(&cues),
        Format::Vtt => vtt::write(&cues),
        Format::Ass => ass::write(&cues, subtitles.ass.as_ref(), false),
        Format::Ssa => ass::write(&cues, subtitles.ass.as_ref(), true),
        Format::SubViewer => subviewer::write(&cues),
        Format::MicroDvd => microdvd::write(
            &cues,
            frame_rate.ok_or("MicroDVD counts frames: it needs a frame rate")?,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_each_format_by_what_is_in_it() {
        let cases = [
            ("1\n00:00:01,000 --> 00:00:02,000\nHi\n", Format::Srt),
            ("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n", Format::Vtt),
            ("[Script Info]\nScriptType: v4.00+\n", Format::Ass),
            (
                "[Script Info]\nScriptType: v4.00\n[V4 Styles]\n",
                Format::Ssa,
            ),
            ("[INFORMATION]\n[TITLE]x\n", Format::SubViewer),
            ("00:00:01.00,00:00:02.00\nHi\n", Format::SubViewer),
            ("{24}{48}Hi\n", Format::MicroDvd),
        ];
        for (text, format) in cases {
            assert_eq!(detect(text, None), Some(format), "{text:?}");
        }
        assert_eq!(detect("nonsense", Some("film.srt")), Some(Format::Srt));
        assert_eq!(detect("nonsense", None), None);
    }

    #[test]
    fn converts_between_formats_keeping_times_lines_and_italics() {
        let srt = "1\n00:00:01,500 --> 00:00:03,250\n<i>Hello</i>\nthere\n\n2\n00:01:02,000 --> 00:01:04,000\nBye\n";
        let opened = open(srt.as_bytes(), None, None).unwrap();
        for format in [
            Format::Srt,
            Format::Vtt,
            Format::Ass,
            Format::Ssa,
            Format::SubViewer,
        ] {
            let text = save(&opened.subtitles, format, None).unwrap();
            let again = open(text.as_bytes(), None, None).unwrap();
            assert_eq!(again.format, format, "{text}");
            assert_eq!(again.subtitles.cues.len(), 2, "{format:?}");
            let first = &again.subtitles.cues[0];
            assert!(
                (first.start - 1.5).abs() < 0.011 && (first.end - 3.25).abs() < 0.011,
                "{format:?}: {first:?}"
            );
            let expected = if format == Format::SubViewer {
                "Hello\nthere"
            } else {
                "<i>Hello</i>\nthere"
            };
            assert_eq!(first.text, expected, "{format:?}");
        }
        let micro = save(&opened.subtitles, Format::MicroDvd, Some(25.0)).unwrap();
        let again = open(micro.as_bytes(), None, Some(25.0)).unwrap();
        assert_eq!(again.subtitles.cues[1].start, 62.0);
        assert_eq!(again.subtitles.cues[0].text, "<i>Hello</i>\nthere");
    }

    #[test]
    fn reads_a_file_in_an_old_encoding() {
        // "Café à côté" in windows-1252.
        let mut bytes = b"1\n00:00:01,000 --> 00:00:02,000\nCaf".to_vec();
        bytes.extend([0xe9, b' ', 0xe0, b' ', b'c', 0xf4, b't', 0xe9, b'\n']);
        let opened = open(&bytes, None, None).unwrap();
        assert_eq!(opened.subtitles.cues[0].text, "Café à côté");
        assert_eq!(opened.encoding, "windows-1252");
    }

    #[test]
    fn says_what_it_cannot_open() {
        assert!(open(b"just some words", Some("notes.txt"), None).is_err());
        assert!(open(b"WEBVTT\n\n", None, None).is_err());
    }
}
