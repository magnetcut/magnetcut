// The film on Windows, written by Media Foundation's sink writer: H.264 or
// HEVC from the frames drawn and AAC from the mix, in MP4, in hardware where
// the system has an encoder (NVENC, AMF and Quick Sync are Media Foundation
// transforms), as `encode.rs` does with AVFoundation on macOS.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use windows::Win32::Media::MediaFoundation::{
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonQuality,
    CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncMPVDefaultBPictureCount,
    CODECAPI_AVEncMPVGOPSize, IMFAttributes, IMFByteStream, IMFMediaBuffer, IMFMediaType,
    IMFSample, IMFSinkWriter, IMFSourceReader, MF_MT_DEFAULT_STRIDE, MF_MT_MPEG2_PROFILE,
    MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READERF_ENDOFSTREAM, MF_TRANSCODE_CONTAINERTYPE,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL,
    MFMediaType_Video, MFNominalRange_0_255, MFNominalRange_16_235, MFT_CATEGORY_VIDEO_ENCODER,
    MFTranscodeContainerType_MPEG4, MFVideoFormat_H264, MFVideoFormat_HEVC, MFVideoFormat_RGB32,
    eAVEncCommonRateControlMode_Quality, eAVEncCommonRateControlMode_UnconstrainedVBR,
    eAVEncH264VProfile_High, eAVEncH265VProfile_Main_420_8,
};
use windows::core::{GUID, PCWSTR};

use super::frames::FrameBuffer;
use super::media_foundation::{
    TICKS_PER_SECOND, attributes, audio_type, buffer, encoders, hd_colors, sample, start, text,
    video_type, wide,
};
use super::settings::{
    Audio, AudioSettings, Capabilities, Container, KEY_FRAME_INTERVAL, SubtitleTrack, VideoCodec,
    VideoSettings,
};
use super::timed_text;

// A sound sample's length, in seconds: short, so the sound and the pictures
// interleave closely.
const AUDIO_CHUNK: f64 = 0.1;

// How far the sound written runs ahead of the frames: the file interleaves
// the two, and sound far ahead would wait in the writer for the frames.
const AUDIO_AHEAD: f64 = 0.5;

// The rates Windows's AAC encoder takes, in bytes a second.
const AAC_RATES: [u32; 4] = [12_000, 16_000, 20_000, 24_000];

/// Whether H.264 and HEVC take a constant quality here: by Media
/// Foundation's quality rate control, which Microsoft's encoders take. One
/// that won't is given the bitrate instead (`Writer::with_subtitles`).
pub fn constant_quality() -> bool {
    true
}

/// The codec's encoder input, as Media Foundation names it.
fn subtype(codec: VideoCodec) -> Option<GUID> {
    match codec {
        VideoCodec::Avc => Some(MFVideoFormat_H264),
        VideoCodec::Hevc => Some(MFVideoFormat_HEVC),
        VideoCodec::ProRes | VideoCodec::ProResHq | VideoCodec::Av1 => None,
    }
}

/// What the native export makes on this computer: the codecs it has
/// encoders for.
pub fn capabilities() -> Capabilities {
    let video_codecs = [VideoCodec::Avc, VideoCodec::Hevc]
        .into_iter()
        .filter(|&codec| {
            subtype(codec).is_some_and(|subtype| {
                encoders(MFT_CATEGORY_VIDEO_ENCODER, MFMediaType_Video, subtype)
                    .is_ok_and(|names| !names.is_empty())
            })
        })
        .collect();
    Capabilities {
        formats: vec![Container::Mp4],
        video_codecs,
        constant_quality: constant_quality(),
        audio_copy: true,
        // Added once the file's finished (`timed_text.rs`).
        subtitle_tracks: true,
    }
}

/// A frame for the encoder: BGRA, top row first, in Media Foundation's memory.
pub struct FrameMemory {
    buffer: IMFMediaBuffer,
    size: (u32, u32),
}

impl FrameBuffer for FrameMemory {
    fn write(&self, data: &[u8], row: usize) -> Result<(), String> {
        let (width, height) = (self.size.0 as usize, self.size.1 as usize);
        let length = width * 4;
        if data.len() < row * (height - 1) + length {
            return Err("the encoder's buffer isn't the frame's size".into());
        }
        let mut target = std::ptr::null_mut();
        let mut capacity = 0u32;
        unsafe { self.buffer.Lock(&mut target, Some(&mut capacity), None) }.map_err(text)?;
        if (capacity as usize) < length * height {
            unsafe { self.buffer.Unlock() }.map_err(text)?;
            return Err("the encoder's buffer isn't the frame's size".into());
        }
        // SAFETY: locked, the buffer holds `capacity` bytes.
        let target = unsafe { std::slice::from_raw_parts_mut(target, length * height) };
        for (y, line) in target.chunks_exact_mut(length).enumerate() {
            line.copy_from_slice(&data[y * row..y * row + length]);
        }
        unsafe {
            self.buffer.Unlock().map_err(text)?;
            self.buffer
                .SetCurrentLength((length * height) as u32)
                .map_err(text)
        }
    }
}

/// The mix, held until the frames are near: 16-bit, interleaved.
struct Sound {
    stream: u32,
    settings: AudioSettings,
    queued: VecDeque<i16>,
    /// Sample frames written so far.
    written: i64,
    /// Whether the mix has all come.
    is_complete: bool,
}

/// A file's sound, read as it's stored and passed into the film as it is.
struct CopiedSound {
    reader: IMFSourceReader,
    stream: u32,
    /// Where the timeline stops hearing it, in hundreds of nanoseconds.
    end: i64,
    /// Where the next sample to write starts.
    at: i64,
    is_done: bool,
}

impl CopiedSound {
    /// The first sound of the file at `location`, AAC as it's stored, in a
    /// stream of the writer's that takes it as it is.
    fn open(writer: &IMFSinkWriter, location: &Path, end: f64) -> Result<Self, String> {
        let url = wide(location)?;
        let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), None) }
            .map_err(|error| format!("Couldn't read the sound to copy: {error}"))?;
        let sound = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        unsafe {
            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .map_err(text)?;
            reader.SetStreamSelection(sound, true).map_err(text)?;
        }
        let stored = unsafe { reader.GetNativeMediaType(sound, 0) }.map_err(text)?;
        if unsafe { stored.GetGUID(&MF_MT_SUBTYPE) }.map_err(text)? != MFAudioFormat_AAC {
            return Err("Windows's own export copies only AAC sound".into());
        }
        unsafe { reader.SetCurrentMediaType(sound, None, &stored) }.map_err(text)?;
        // The same type in as out: no encoder between them.
        let stream = unsafe { writer.AddStream(&stored) }.map_err(text)?;
        unsafe { writer.SetInputMediaType(stream, &stored, None::<&IMFAttributes>) }
            .map_err(|error| format!("This computer can't copy the sound: {error}"))?;
        Ok(Self {
            reader,
            stream,
            end: (end * TICKS_PER_SECOND as f64) as i64,
            at: 0,
            is_done: false,
        })
    }

    /// Passes the stored samples into the film up to `until` (in hundreds of
    /// nanoseconds), or where the timeline stops hearing them.
    fn write(&mut self, writer: &IMFSinkWriter, until: i64) -> Result<(), String> {
        let sound = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        while !self.is_done && self.at < until {
            let mut flags = 0u32;
            let mut time = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                self.reader.ReadSample(
                    sound,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut time),
                    Some(&mut sample),
                )
            }
            .map_err(text)?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 || time >= self.end {
                self.is_done = true;
                break;
            }
            let Some(sample) = sample else {
                continue;
            };
            unsafe { writer.WriteSample(self.stream, &sample) }
                .map_err(|error| format!("Couldn't copy the sound: {error}"))?;
            self.at = time;
        }
        Ok(())
    }
}

pub struct Writer {
    writer: IMFSinkWriter,
    path: PathBuf,
    video: u32,
    sound: Option<Sound>,
    copy: Option<CopiedSound>,
    /// Added as timed text once Media Foundation has finished the file.
    subtitles: Vec<SubtitleTrack>,
    size: (u32, u32),
    fps: (u32, u32),
    frames: i64,
}

impl Writer {
    /// Starts a file at `path`, replacing what's there: with no subtitles,
    /// as the tests make them.
    #[cfg(test)]
    pub fn new(
        path: &Path,
        container: Container,
        video: &VideoSettings,
        audio: Option<Audio>,
    ) -> Result<Self, String> {
        Self::with_subtitles(path, container, video, audio, &[])
    }

    /// Starts a file at `path`, replacing what's there, with subtitle tracks
    /// as timed text, added once it's finished.
    pub fn with_subtitles(
        path: &Path,
        container: Container,
        video: &VideoSettings,
        audio: Option<Audio>,
        subtitles: &[SubtitleTrack],
    ) -> Result<Self, String> {
        if container != Container::Mp4 {
            return Err("Windows's own export makes only MP4 files".into());
        }
        let subtype = subtype(video.codec)
            .ok_or_else(|| format!("Windows's own export doesn't encode {:?}", video.codec))?;
        let (audio, copy) = match audio {
            Some(Audio::Mix(settings)) => (Some(settings), None),
            Some(Audio::Copy { location, end }) => (None, Some((location, end))),
            None => (None, None),
        };
        start()?;
        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string());
            }
            _ => {}
        }
        let url = wide(path)?;
        // An MP4 whatever the name. Its index stays at the end: put first
        // (MF_MPEG4SINK_MOOV_BEFORE_MDAT), files finished at the same time
        // were refused ("Access is denied"), as if they shared the sink's
        // scratch file.
        let settings = attributes(
            &[(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)],
            &[(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4)],
        )?;
        let writer = unsafe {
            MFCreateSinkWriterFromURL(PCWSTR(url.as_ptr()), None::<&IMFByteStream>, &settings)
        }
        .map_err(text)?;
        let size = (video.width, video.height);
        let fps = (video.fps.numerator, video.fps.denominator);
        let encoded = encoded_type(subtype, video)?;
        let video_stream = unsafe { writer.AddStream(&encoded) }
            .map_err(|error| format!("This computer can't encode {:?}: {error}", video.codec))?;
        let frames = video_type(MFVideoFormat_RGB32, size, fps, None)?;
        // Rows top first, in HD's colours as the file is.
        unsafe { frames.SetUINT32(&MF_MT_DEFAULT_STRIDE, size.0 * 4) }.map_err(text)?;
        hd_colors(&frames, MFNominalRange_0_255)?;
        // The bitrate as an average, a key frame every two seconds, and no
        // frames stored out of order, where the encoder takes them; as it
        // likes, where not. Out of order, Microsoft's encoder's frames came
        // back a frame late.
        let gop = (f64::from(fps.0) / f64::from(fps.1) * KEY_FRAME_INTERVAL).round() as u32;
        let rest = [
            (CODECAPI_AVEncMPVGOPSize, gop.max(1)),
            (CODECAPI_AVEncMPVDefaultBPictureCount, 0),
        ];
        let by_bitrate = [
            (
                CODECAPI_AVEncCommonRateControlMode,
                eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32,
            ),
            (CODECAPI_AVEncCommonMeanBitRate, video.bitrate),
        ];
        // A constant quality, from 1 to 100, where asked for and taken; the
        // bitrate, where not.
        let by_quality = video.quality.map(|quality| {
            [
                (
                    CODECAPI_AVEncCommonRateControlMode,
                    eAVEncCommonRateControlMode_Quality.0 as u32,
                ),
                (
                    CODECAPI_AVEncCommonQuality,
                    (quality * 100.0).round().clamp(1.0, 100.0) as u32,
                ),
            ]
        });
        let mut choices = Vec::new();
        if let Some(by_quality) = by_quality {
            choices.push(Some(attributes(&[&by_quality[..], &rest].concat(), &[])?));
        }
        choices.push(Some(attributes(&[&by_bitrate[..], &rest].concat(), &[])?));
        choices.push(None);
        let mut set = Err(String::new());
        for parameters in choices {
            set = unsafe { writer.SetInputMediaType(video_stream, &frames, parameters.as_ref()) }
                .map_err(|error| {
                    format!(
                        "This computer can't encode {:?} at {}x{}: {error}",
                        video.codec, size.0, size.1
                    )
                });
            if set.is_ok() {
                break;
            }
        }
        set?;
        let sound = match audio {
            Some(settings) => {
                let rate = AAC_RATES
                    .into_iter()
                    .rfind(|&rate| rate * 8 <= settings.bitrate)
                    .unwrap_or(AAC_RATES[0]);
                let encoded = audio_type(
                    MFAudioFormat_AAC,
                    settings.channels,
                    settings.sample_rate,
                    Some(rate * 8),
                )?;
                let stream = unsafe { writer.AddStream(&encoded) }.map_err(text)?;
                let samples = audio_type(
                    MFAudioFormat_PCM,
                    settings.channels,
                    settings.sample_rate,
                    None,
                )?;
                unsafe { writer.SetInputMediaType(stream, &samples, None::<&IMFAttributes>) }
                    .map_err(|error| format!("This computer can't encode the sound: {error}"))?;
                Some(Sound {
                    stream,
                    settings,
                    queued: VecDeque::new(),
                    written: 0,
                    is_complete: false,
                })
            }
            None => None,
        };
        let copy = copy
            .map(|(location, end)| CopiedSound::open(&writer, &location, end))
            .transpose()?;
        unsafe { writer.BeginWriting() }.map_err(text)?;
        Ok(Self {
            writer,
            path: path.to_owned(),
            video: video_stream,
            sound,
            copy,
            subtitles: subtitles.to_vec(),
            size,
            fps,
            frames: 0,
        })
    }

    /// A buffer for the next frame.
    pub fn pixel_buffer(&self) -> Result<FrameMemory, String> {
        let length = (self.size.0 * self.size.1 * 4) as usize;
        Ok(FrameMemory {
            buffer: buffer(length, |_| {})?,
            size: self.size,
        })
    }

    /// When frame `index` starts, in hundreds of nanoseconds.
    fn frame_time(&self, index: i64) -> i64 {
        let (numerator, denominator) = (i64::from(self.fps.0), i64::from(self.fps.1));
        index * denominator * TICKS_PER_SECOND / numerator
    }

    /// Adds the next frame: the writer waits while the encoder's behind.
    pub fn add_frame(&mut self, frame: &FrameMemory) -> Result<(), String> {
        let time = self.frame_time(self.frames);
        let next = self.frame_time(self.frames + 1);
        let frame = sample(&frame.buffer, time, next - time)?;
        unsafe { self.writer.WriteSample(self.video, &frame) }
            .map_err(|error| format!("Couldn't encode a frame: {error}"))?;
        self.frames += 1;
        self.write_sound(next as f64 / TICKS_PER_SECOND as f64 + AUDIO_AHEAD)?;
        let ahead = (AUDIO_AHEAD * TICKS_PER_SECOND as f64) as i64;
        if let Some(copy) = &mut self.copy {
            copy.write(&self.writer, next + ahead)?;
        }
        Ok(())
    }

    /// Adds the mix's next samples: float, interleaved; and whether they're
    /// its last.
    pub fn add_audio(&mut self, samples: &[f32], is_last: bool) -> Result<(), String> {
        let Some(sound) = &mut self.sound else {
            return Err("the export takes no mix".into());
        };
        if sound.is_complete {
            return Err("the sound has already ended".into());
        }
        sound.queued.extend(
            samples
                .iter()
                .map(|value| (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16),
        );
        sound.is_complete = is_last;
        let shown = self.frame_time(self.frames) as f64 / TICKS_PER_SECOND as f64;
        self.write_sound(shown + AUDIO_AHEAD)
    }

    /// Writes the sound held, up to `until` seconds.
    fn write_sound(&mut self, until: f64) -> Result<(), String> {
        let Some(sound) = &mut self.sound else {
            return Ok(());
        };
        let channels = sound.settings.channels as usize;
        let rate = i64::from(sound.settings.sample_rate);
        let chunk = (AUDIO_CHUNK * rate as f64) as usize;
        while (sound.written as f64) < until * rate as f64 {
            let held = sound.queued.len() / channels;
            // A short last piece only once the mix is over.
            let count = if held >= chunk || (sound.is_complete && held > 0) {
                held.min(chunk)
            } else {
                break;
            };
            let data = buffer(count * channels * 2, |data| {
                for (bytes, value) in data
                    .as_chunks_mut::<2>()
                    .0
                    .iter_mut()
                    .zip(sound.queued.drain(..count * channels))
                {
                    *bytes = value.to_le_bytes();
                }
            })?;
            let time = sound.written * TICKS_PER_SECOND / rate;
            let end = (sound.written + count as i64) * TICKS_PER_SECOND / rate;
            let piece = sample(&data, time, end - time)?;
            unsafe { self.writer.WriteSample(sound.stream, &piece) }
                .map_err(|error| format!("Couldn't write the sound: {error}"))?;
            sound.written += count as i64;
        }
        Ok(())
    }

    /// Finishes the file, with all the sound held.
    pub fn finish(mut self) -> Result<(), String> {
        if let Some(sound) = &mut self.sound {
            sound.is_complete = true;
        }
        self.write_sound(f64::INFINITY)?;
        if let Some(copy) = &mut self.copy {
            copy.write(&self.writer, i64::MAX)?;
        }
        unsafe { self.writer.Finalize() }
            .map_err(|error| format!("Couldn't finish the file: {error}"))?;
        timed_text::finish(&self.path, &self.subtitles, self.size)
    }

    /// Stops, leaving the file for the caller to delete: closed, so it can be.
    pub fn cancel(self) {
        let _ = unsafe { self.writer.Finalize() };
    }
}

/// What the encoder makes: the codec at the bitrate, in HD's colours, which
/// the editor's pictures are in.
fn encoded_type(subtype: GUID, video: &VideoSettings) -> Result<IMFMediaType, String> {
    let media_type = video_type(
        subtype,
        (video.width, video.height),
        (video.fps.numerator, video.fps.denominator),
        Some(video.bitrate),
    )?;
    let profile = if subtype == MFVideoFormat_H264 {
        eAVEncH264VProfile_High.0 as u32
    } else {
        eAVEncH265VProfile_Main_420_8.0 as u32
    };
    unsafe { media_type.SetUINT32(&MF_MT_MPEG2_PROFILE, profile) }.map_err(text)?;
    hd_colors(&media_type, MFNominalRange_16_235)?;
    Ok(media_type)
}
