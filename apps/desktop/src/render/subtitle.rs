// Subtitle tracks as Apple's players show them: 3GPP timed text (tx3g, the
// "mov_text" of MP4), written by AVAssetWriter beside the picture and sound
// (docs/SUBTITLES.md, phase 6). Each sample is a line's text, after its
// length; a stretch with no line is an empty sample, which clears the screen.

use std::collections::VecDeque;
use std::ptr::{self, NonNull};

use super::av::{any, av, bridged, cf_dictionary, describe, dictionary, packet_sample, seconds};
use super::settings::{SubtitleCue, SubtitleTrack};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{AVAssetWriter, AVAssetWriterInput, AVMediaTypeSubtitle};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMFormatDescription, CMSampleBuffer, kCMMediaType_Subtitle,
    kCMTextFormatDescriptionColor_Alpha, kCMTextFormatDescriptionColor_Blue,
    kCMTextFormatDescriptionColor_Green, kCMTextFormatDescriptionColor_Red,
    kCMTextFormatDescriptionExtension_BackgroundColor,
    kCMTextFormatDescriptionExtension_DefaultStyle,
    kCMTextFormatDescriptionExtension_DefaultTextBox,
    kCMTextFormatDescriptionExtension_DisplayFlags, kCMTextFormatDescriptionExtension_FontTable,
    kCMTextFormatDescriptionExtension_HorizontalJustification,
    kCMTextFormatDescriptionExtension_VerticalJustification, kCMTextFormatDescriptionRect_Bottom,
    kCMTextFormatDescriptionRect_Left, kCMTextFormatDescriptionRect_Right,
    kCMTextFormatDescriptionRect_Top, kCMTextFormatDescriptionStyle_EndChar,
    kCMTextFormatDescriptionStyle_Font, kCMTextFormatDescriptionStyle_FontFace,
    kCMTextFormatDescriptionStyle_FontSize, kCMTextFormatDescriptionStyle_ForegroundColor,
    kCMTextFormatDescriptionStyle_StartChar, kCMTextFormatType_3GText,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString};

pub struct SubtitleInput {
    input: Retained<AVAssetWriterInput>,
    queued: VecDeque<CFRetained<CMSampleBuffer>>,
    is_finished: bool,
}

// The text's size, as a share of the picture's height.
const FONT_SIZE: f64 = 0.05;

fn color(
    red: u32,
    green: u32,
    blue: u32,
    alpha: u32,
) -> Retained<NSDictionary<NSString, AnyObject>> {
    let [red, green, blue, alpha] = [red, green, blue, alpha].map(NSNumber::new_u32);
    dictionary(&[
        (
            bridged(unsafe { kCMTextFormatDescriptionColor_Red }),
            any(&red),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionColor_Green }),
            any(&green),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionColor_Blue }),
            any(&blue),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionColor_Alpha }),
            any(&alpha),
        ),
    ])
}

/// Timed text's format: white sans-serif at the foot of a picture this size.
fn format((width, height): (u32, u32)) -> Result<CFRetained<CMFormatDescription>, String> {
    let zero = NSNumber::new_u32(0);
    let one = NSNumber::new_u32(1);
    // In 3GPP's: 1 centred; -1 at the foot.
    let centred = NSNumber::new_i32(1);
    let foot = NSNumber::new_i32(-1);
    let (top, left) = (NSNumber::new_u32(0), NSNumber::new_u32(0));
    let (bottom, right) = (NSNumber::new_u32(height), NSNumber::new_u32(width));
    let size = NSNumber::new_u32(((f64::from(height) * FONT_SIZE).round() as u32).clamp(12, 255));
    let text_box = dictionary(&[
        (
            bridged(unsafe { kCMTextFormatDescriptionRect_Top }),
            any(&top),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionRect_Left }),
            any(&left),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionRect_Bottom }),
            any(&bottom),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionRect_Right }),
            any(&right),
        ),
    ]);
    let white = color(255, 255, 255, 255);
    let clear = color(0, 0, 0, 0);
    let style = dictionary(&[
        (
            bridged(unsafe { kCMTextFormatDescriptionStyle_StartChar }),
            any(&zero),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionStyle_EndChar }),
            any(&zero),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionStyle_Font }),
            any(&one),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionStyle_FontFace }),
            any(&zero),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionStyle_FontSize }),
            any(&size),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionStyle_ForegroundColor }),
            any(&white),
        ),
    ]);
    // Font 1, as the style names it.
    let font_id = NSString::from_str("1");
    let font_name = NSString::from_str("Sans-Serif");
    let fonts = dictionary(&[(&*font_id, any(&font_name))]);
    let extensions = dictionary(&[
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_DisplayFlags }),
            any(&zero),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_BackgroundColor }),
            any(&clear),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_DefaultTextBox }),
            any(&text_box),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_DefaultStyle }),
            any(&style),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_FontTable }),
            any(&fonts),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_HorizontalJustification }),
            any(&centred),
        ),
        (
            bridged(unsafe { kCMTextFormatDescriptionExtension_VerticalJustification }),
            any(&foot),
        ),
    ]);
    let mut format = ptr::null();
    let status = unsafe {
        CMFormatDescription::create(
            None,
            kCMMediaType_Subtitle,
            kCMTextFormatType_3GText,
            Some(cf_dictionary(&extensions)),
            NonNull::from(&mut format),
        )
    };
    let format = NonNull::new(format.cast_mut())
        .filter(|_| status == 0)
        .ok_or("Couldn't describe the subtitles")?;
    // SAFETY: created, so ours to release.
    Ok(unsafe { CFRetained::from_raw(format) })
}

/// A timed text sample: the text's length in bytes, big end first, then the
/// text in UTF-8; empty, it clears the screen.
pub fn sample_data(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let length = bytes.len().min(usize::from(u16::MAX));
    let mut data = Vec::with_capacity(length + 2);
    data.extend((length as u16).to_be_bytes());
    data.extend(&bytes[..length]);
    data
}

/// The track's samples, one after another from zero: each line, and an empty
/// sample for each stretch with none.
fn samples(
    cues: &[SubtitleCue],
    format: &CMFormatDescription,
) -> Result<VecDeque<CFRetained<CMSampleBuffer>>, String> {
    let mut cues: Vec<&SubtitleCue> = cues.iter().filter(|cue| cue.end > cue.start).collect();
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut samples = VecDeque::new();
    let mut at = 0.0;
    for cue in cues {
        let start = cue.start.max(at);
        if cue.end <= start {
            continue;
        }
        if start > at {
            samples.push_back(packet_sample(
                &sample_data(""),
                format,
                seconds(at),
                seconds(start - at),
            )?);
        }
        samples.push_back(packet_sample(
            &sample_data(&cue.text),
            format,
            seconds(start),
            seconds(cue.end - start),
        )?);
        at = cue.end;
    }
    Ok(samples)
}

impl SubtitleInput {
    /// A subtitle track for the writer, its samples made ready.
    pub fn new(
        writer: &AVAssetWriter,
        track: &SubtitleTrack,
        size: (u32, u32),
    ) -> Result<Self, String> {
        let format = format(size)?;
        let input = unsafe {
            AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings_sourceFormatHint(
                av!(AVMediaTypeSubtitle),
                None,
                Some(&format),
            )
        };
        unsafe { input.setExpectsMediaDataInRealTime(false) };
        if !unsafe { writer.canAddInput(&input) } {
            return Err("The file can't take a subtitle track".into());
        }
        unsafe { writer.addInput(&input) };
        Ok(Self {
            input,
            queued: samples(&track.cues, &format)?,
            is_finished: false,
        })
    }

    /// Hands over as many samples as the writer takes now, and says when
    /// there are no more.
    pub fn drain(&mut self, writer: &AVAssetWriter) -> Result<(), String> {
        if self.is_finished {
            return Ok(());
        }
        while unsafe { self.input.isReadyForMoreMediaData() } {
            let Some(sample) = self.queued.pop_front() else {
                break;
            };
            if !unsafe { self.input.appendSampleBuffer(&sample) } {
                return Err(describe(
                    unsafe { writer.error() },
                    "Couldn't write the subtitles",
                ));
            }
        }
        if self.queued.is_empty() {
            unsafe { self.input.markAsFinished() };
            self.is_finished = true;
        }
        Ok(())
    }

    pub fn is_finished(&self) -> bool {
        self.is_finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_is_the_text_after_its_length() {
        assert_eq!(sample_data("Hi"), [0, 2, b'H', b'i']);
        assert_eq!(sample_data(""), [0, 0]);
        assert_eq!(sample_data("é").len(), 4);
    }
}
