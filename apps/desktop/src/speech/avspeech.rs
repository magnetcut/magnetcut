// The Mac's own voices: AVSpeechSynthesizer, writing its speech into buffers
// instead of to the speakers, until an empty one says it's done. It hands
// them over on the main thread, so they're waited for on another: the main
// thread is the app's, running its event loop.

use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::NSObjectProtocol;
use objc2::sel;
use objc2_avf_audio::{
    AVAudioBuffer, AVAudioCommonFormat, AVAudioPCMBuffer, AVSpeechBoundary, AVSpeechSynthesisVoice,
    AVSpeechSynthesisVoiceQuality, AVSpeechSynthesisVoiceTraits, AVSpeechSynthesizer,
    AVSpeechUtterance,
};
use objc2_foundation::NSString;

use super::{Voice, wav};

/// How long the synthesizer may go without a buffer before it's given up on.
const PATIENCE: Duration = Duration::from_secs(30);

pub fn voices() -> Result<Vec<Voice>, String> {
    let voices = unsafe { AVSpeechSynthesisVoice::speechVoices() };
    let mut voices: Vec<Voice> = voices
        .iter()
        .map(|voice| unsafe {
            let quality = voice.quality();
            // Its traits from macOS 14.
            let novelty = voice.respondsToSelector(sel!(voiceTraits))
                && voice
                    .voiceTraits()
                    .contains(AVSpeechSynthesisVoiceTraits::IsNoveltyVoice);
            let description = if quality == AVSpeechSynthesisVoiceQuality::Premium {
                Some("Premium")
            } else if quality == AVSpeechSynthesisVoiceQuality::Enhanced {
                Some("Enhanced")
            } else if novelty {
                Some("Novelty")
            } else {
                None
            };
            Voice {
                id: voice.identifier().to_string(),
                name: voice.name().to_string(),
                language: Some(voice.language().to_string()),
                description: description.map(str::to_owned),
            }
        })
        .collect();
    voices.sort_by(|a, b| (&a.language, &a.name).cmp(&(&b.language, &b.name)));
    Ok(voices)
}

/// A buffer's worth: its sample rate and first channel's samples. Empty at
/// the end.
struct Piece {
    sample_rate: f64,
    samples: Vec<i16>,
}

/// The text spoken by the voice with this identifier (the system's default
/// for an empty one), as a WAV file. Not on the main thread, which it would
/// wait for.
pub fn speak(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let utterance =
        unsafe { AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(text)) };
    if !voice.is_empty() {
        let found =
            unsafe { AVSpeechSynthesisVoice::voiceWithIdentifier(&NSString::from_str(voice)) }
                .ok_or_else(|| format!("no voice {voice} on this Mac"))?;
        unsafe { utterance.setVoice(Some(&found)) };
    }
    let (sender, receiver) = mpsc::channel();
    let callback: RcBlock<dyn Fn(NonNull<AVAudioBuffer>)> =
        RcBlock::new(move |buffer: NonNull<AVAudioBuffer>| {
            let buffer = unsafe { buffer.as_ref() };
            let piece = buffer.downcast_ref::<AVAudioPCMBuffer>().and_then(read);
            // Gone if the speech was given up on.
            let _ = sender.send(piece);
        });
    let synthesizer = unsafe { AVSpeechSynthesizer::new() };
    unsafe { synthesizer.writeUtterance_toBufferCallback(&utterance, RcBlock::as_ptr(&callback)) };

    let mut sample_rate = 0.0;
    let mut samples = Vec::new();
    let finished = loop {
        let piece = match receiver.recv_timeout(PATIENCE) {
            Ok(Some(piece)) => piece,
            Ok(None) => break Err("the voice gave back samples not read here"),
            Err(_) => break Err("the voice stopped speaking"),
        };
        if piece.samples.is_empty() {
            break Ok(());
        }
        sample_rate = piece.sample_rate;
        samples.extend_from_slice(&piece.samples);
    };
    // Kept until the last buffer, which it would otherwise not send.
    if finished.is_err() {
        unsafe { synthesizer.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate) };
    }
    drop(synthesizer);
    finished?;
    if samples.is_empty() {
        return Err("the voice said nothing".into());
    }
    Ok(wav::from_samples(sample_rate.round() as u32, &samples))
}

/// What's in a buffer: none if it's in a format not read here.
fn read(buffer: &AVAudioPCMBuffer) -> Option<Piece> {
    unsafe {
        let format = buffer.format();
        let frames = buffer.frameLength() as usize;
        // Between one frame and the next, in samples: the channel count if
        // they're interleaved, else 1.
        let stride = buffer.stride().max(1);
        let common = format.commonFormat();
        let samples = if frames == 0 {
            Vec::new()
        } else if common == AVAudioCommonFormat::PCMFormatFloat32 {
            first_channel(buffer.floatChannelData(), frames, stride, |&sample| {
                wav::to_i16(sample)
            })?
        } else if common == AVAudioCommonFormat::PCMFormatInt16 {
            first_channel(buffer.int16ChannelData(), frames, stride, |&sample| sample)?
        } else if common == AVAudioCommonFormat::PCMFormatInt32 {
            first_channel(buffer.int32ChannelData(), frames, stride, |&sample| {
                (sample >> 16) as i16
            })?
        } else {
            return None;
        };
        Some(Piece {
            sample_rate: format.sampleRate(),
            samples,
        })
    }
}

/// The first channel's samples, from the buffer's array of channel pointers:
/// none if it has none.
///
/// # Safety
/// `channels` is null or points to a channel holding `frames * stride`
/// samples, as a PCM buffer's channel data does.
unsafe fn first_channel<T>(
    channels: *mut NonNull<T>,
    frames: usize,
    stride: usize,
    convert: impl Fn(&T) -> i16,
) -> Option<Vec<i16>> {
    if channels.is_null() {
        return None;
    }
    let first = unsafe { (*channels).as_ptr() };
    let samples = (0..frames)
        .map(|frame| convert(unsafe { &*first.add(frame * stride) }))
        .collect();
    Some(samples)
}

#[cfg(test)]
mod tests {
    use objc2::AnyThread;
    use objc2_avf_audio::{AVAudioCommonFormat, AVAudioFormat, AVAudioPCMBuffer};

    use super::read;

    fn buffer(
        format: AVAudioCommonFormat,
        channels: u32,
        interleaved: bool,
        frames: u32,
    ) -> objc2::rc::Retained<AVAudioPCMBuffer> {
        unsafe {
            let format = AVAudioFormat::initWithCommonFormat_sampleRate_channels_interleaved(
                AVAudioFormat::alloc(),
                format,
                22_050.0,
                channels,
                interleaved,
            )
            .unwrap();
            let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &format,
                frames,
            )
            .unwrap();
            buffer.setFrameLength(frames);
            buffer
        }
    }

    #[test]
    fn float_buffer() {
        // As the synthesizer gives them: float, mono, apart.
        let buffer = buffer(AVAudioCommonFormat::PCMFormatFloat32, 1, false, 3);
        unsafe {
            let samples = (*buffer.floatChannelData()).as_ptr();
            for (at, sample) in [0.5f32, -1.0, 2.0].into_iter().enumerate() {
                *samples.add(at) = sample;
            }
        }
        let piece = read(&buffer).unwrap();
        assert_eq!(piece.sample_rate, 22_050.0);
        assert_eq!(piece.samples, [16384, -32768, 32767]);
    }

    #[test]
    fn interleaved_buffer() {
        // The first of two channels, side by side.
        let buffer = buffer(AVAudioCommonFormat::PCMFormatInt16, 2, true, 2);
        unsafe {
            let samples = (*buffer.int16ChannelData()).as_ptr();
            for (at, sample) in [1i16, 2, 3, 4].into_iter().enumerate() {
                *samples.add(at) = sample;
            }
        }
        assert_eq!(read(&buffer).unwrap().samples, [1, 3]);
    }

    #[test]
    fn last_and_unread_buffers() {
        let last = buffer(AVAudioCommonFormat::PCMFormatFloat32, 1, false, 0);
        assert!(read(&last).unwrap().samples.is_empty());
        let float64 = buffer(AVAudioCommonFormat::PCMFormatFloat64, 1, false, 4);
        assert!(read(&float64).is_none());
    }
}
