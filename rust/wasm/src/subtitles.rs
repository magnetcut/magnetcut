#![cfg(target_arch = "wasm32")]

// Subtitles (rust/crates/subtitles) for the editor: files opened and saved,
// retimed, and timed to the speech.

use serde::Serialize;
use serde::de::DeserializeOwned;
use subtitles::align::{self, Span, Word};
use subtitles::timing::{self, DurationRules, Retime};
use subtitles::{Cue, Format, Subtitles};
use wasm_bindgen::{JsValue, prelude::wasm_bindgen};

#[wasm_bindgen(typescript_custom_section)]
const SUBTITLE_TYPES: &str = r##"
export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa" | "subviewer" | "microdvd";

/** A subtitle: when it shows, in seconds, and what it says (lines joined by
 * "\n"; <i>, <b> and <u> the only markup). */
export interface SubtitleCueData {
    start: number;
    end: number;
    text: string;
    /** An ASS style, by name. */
    style?: string;
}

export interface AssStyleData {
    name: string;
    fontName: string;
    /** In the script's pixels: playResY of them are the picture's height. */
    fontSize: number;
    /** "#rrggbbaa". */
    primaryColor: string;
    outlineColor: string;
    backColor: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikeOut: boolean;
    spacing: number;
    /** 1 an outline and shadow, 3 an opaque box behind the text. */
    borderStyle: number;
    outline: number;
    shadow: number;
    angle: number;
    scaleX: number;
    scaleY: number;
    /** A numeric keypad's: 1 bottom left, 5 the middle, 9 top right. */
    alignment: number;
    marginLeft: number;
    marginRight: number;
    marginVertical: number;
}

export interface AssScriptData {
    head: string;
    isSsa: boolean;
    playResX: number;
    playResY: number;
    styles: AssStyleData[];
}

export interface SubtitlesData {
    cues: SubtitleCueData[];
    ass?: AssScriptData;
}

export interface OpenedSubtitles {
    subtitles: SubtitlesData;
    format: SubtitleFormat;
    /** As the WHATWG names it: "UTF-8", "windows-1252". */
    encoding: string;
    skipped: number;
    warnings: string[];
}

/** scale * time + offset. */
export interface Retime {
    scale: number;
    offset: number;
}

export interface DurationRules {
    min: number;
    max: number;
    charactersPerSecond: number;
    gap: number;
}

export interface HeardWord {
    text: string;
    start: number;
    end: number;
}

export interface SpeechSpan {
    start: number;
    end: number;
}

export interface SpeechFit {
    retime: Retime;
    /** The share of the lines' time over speech, before and after. */
    overlapBefore: number;
    overlapAfter: number;
}
"##;

fn from_js<T: DeserializeOwned>(value: JsValue, what: &str) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&format!("{what}: {error}")))
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// A subtitle file opened: its encoding and format found.
#[wasm_bindgen(js_name = openSubtitles, unchecked_return_type = "OpenedSubtitles")]
pub fn open_subtitles(
    bytes: &[u8],
    name: Option<String>,
    frame_rate: Option<f64>,
) -> Result<JsValue, JsValue> {
    let opened = subtitles::open(bytes, name.as_deref(), frame_rate)
        .map_err(|error| JsValue::from_str(&error))?;
    to_js(&opened)
}

/// Subtitles as a file's text, in UTF-8.
#[wasm_bindgen(js_name = saveSubtitles)]
pub fn save_subtitles(
    #[wasm_bindgen(unchecked_param_type = "SubtitlesData")] subtitles: JsValue,
    #[wasm_bindgen(unchecked_param_type = "SubtitleFormat")] format: JsValue,
    frame_rate: Option<f64>,
) -> Result<String, JsValue> {
    let subtitles: Subtitles = from_js(subtitles, "subtitles")?;
    let format: Format = from_js(format, "format")?;
    subtitles::save(&subtitles, format, frame_rate).map_err(|error| JsValue::from_str(&error))
}

/// The cues retimed: `scale * time + offset`, none before zero.
#[wasm_bindgen(js_name = retimeCues, unchecked_return_type = "SubtitleCueData[]")]
pub fn retime_cues(
    #[wasm_bindgen(unchecked_param_type = "SubtitleCueData[]")] cues: JsValue,
    #[wasm_bindgen(unchecked_param_type = "Retime")] retime: JsValue,
) -> Result<JsValue, JsValue> {
    let mut cues: Vec<Cue> = from_js(cues, "cues")?;
    timing::retime(&mut cues, from_js(retime, "retime")?);
    to_js(&cues)
}

/// The retime that moves two times to where they should be (Jubler's
/// two-point sync): none if they're the same time.
#[wasm_bindgen(js_name = twoPointRetime, unchecked_return_type = "Retime | undefined")]
pub fn two_point_retime(
    from_a: f64,
    to_a: f64,
    from_b: f64,
    to_b: f64,
) -> Result<JsValue, JsValue> {
    match Retime::two_points((from_a, to_a), (from_b, to_b)) {
        Some(retime) => to_js(&retime),
        None => Ok(JsValue::UNDEFINED),
    }
}

/// The retime for subtitles timed at one frame rate, for a film at another.
#[wasm_bindgen(js_name = frameRateRetime, unchecked_return_type = "Retime")]
pub fn frame_rate_retime(from: f64, to: f64) -> Result<JsValue, JsValue> {
    to_js(&Retime::frame_rate(from, to))
}

/// Each cue ending `gap` before the next starts; in order of their start.
#[wasm_bindgen(js_name = fixSubtitleOverlaps, unchecked_return_type = "SubtitleCueData[]")]
pub fn fix_subtitle_overlaps(
    #[wasm_bindgen(unchecked_param_type = "SubtitleCueData[]")] cues: JsValue,
    gap: f64,
) -> Result<JsValue, JsValue> {
    let mut cues: Vec<Cue> = from_js(cues, "cues")?;
    timing::fix_overlaps(&mut cues, gap);
    to_js(&cues)
}

/// Lines made long enough to read and short enough not to linger; in order
/// of their start. The rules default to Netflix's.
#[wasm_bindgen(js_name = fixSubtitleDurations, unchecked_return_type = "SubtitleCueData[]")]
pub fn fix_subtitle_durations(
    #[wasm_bindgen(unchecked_param_type = "SubtitleCueData[]")] cues: JsValue,
    #[wasm_bindgen(unchecked_param_type = "DurationRules | undefined")] rules: JsValue,
) -> Result<JsValue, JsValue> {
    let mut cues: Vec<Cue> = from_js(cues, "cues")?;
    let rules: DurationRules = if rules.is_undefined() {
        DurationRules::default()
    } else {
        from_js(rules, "rules")?
    };
    timing::fix_durations(&mut cues, rules);
    to_js(&cues)
}

/// Lines of text timed to the words heard (auto-sync): none if none matched.
#[wasm_bindgen(js_name = timeLinesToWords, unchecked_return_type = "SubtitleCueData[] | undefined")]
pub fn time_lines_to_words(
    lines: Vec<String>,
    #[wasm_bindgen(unchecked_param_type = "HeardWord[]")] words: JsValue,
) -> Result<JsValue, JsValue> {
    let words: Vec<Word> = from_js(words, "words")?;
    match align::time_lines(&lines, &words) {
        Some(cues) => to_js(&cues),
        None => Ok(JsValue::UNDEFINED),
    }
}

/// How to retime subtitles to line them up with the speech: none with
/// nothing to go on.
#[wasm_bindgen(js_name = fitSubtitlesToSpeech, unchecked_return_type = "SpeechFit | undefined")]
pub fn fit_subtitles_to_speech(
    #[wasm_bindgen(unchecked_param_type = "SubtitleCueData[]")] cues: JsValue,
    #[wasm_bindgen(unchecked_param_type = "SpeechSpan[]")] speech: JsValue,
) -> Result<JsValue, JsValue> {
    let cues: Vec<Cue> = from_js(cues, "cues")?;
    let speech: Vec<Span> = from_js(speech, "speech")?;
    match align::fit(&cues, &speech) {
        Some(fit) => to_js(&fit),
        None => Ok(JsValue::UNDEFINED),
    }
}

/// When someone's speaking in a mono soundtrack, roughly, by loudness: for
/// lining subtitles up without a speech model.
#[wasm_bindgen(js_name = detectSpeech, unchecked_return_type = "SpeechSpan[]")]
pub fn detect_speech(samples: &[f32], sample_rate: u32) -> Result<JsValue, JsValue> {
    to_js(&align::speech_spans(samples, sample_rate))
}

/// Each line's start and end snapped to the nearest of `starts` and `ends`
/// within `reach` seconds, none made shorter than `shortest`.
#[wasm_bindgen(js_name = snapSubtitleEdges, unchecked_return_type = "SubtitleCueData[]")]
pub fn snap_subtitle_edges(
    #[wasm_bindgen(unchecked_param_type = "SubtitleCueData[]")] cues: JsValue,
    starts: Vec<f64>,
    ends: Vec<f64>,
    reach: f64,
    shortest: f64,
) -> Result<JsValue, JsValue> {
    let mut cues: Vec<Cue> = from_js(cues, "cues")?;
    timing::snap_edges(&mut cues, &starts, &ends, reach, shortest);
    to_js(&cues)
}
