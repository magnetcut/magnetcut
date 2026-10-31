// The film on Linux, written by GStreamer: H.264 or HEVC from the frames
// drawn and AAC from the mix, in MP4, with the best encoders the system has
// (VA-API's in hardware first, then x264, x265 or OpenH264 in software), as
// `encode.rs` does with AVFoundation on macOS.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::Path;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSrc;
use gstreamer_video::{VideoFormat, VideoInfo};

use super::frames::FrameBuffer;
use super::pipeline::{by_name, clock_time, failure, first_element, launch, play};
use super::settings::{
    Audio, AudioSettings, Capabilities, Container, KEY_FRAME_INTERVAL, SubtitleTrack, VideoCodec,
    VideoSettings,
};
use super::timed_text;

// A sound buffer's length, in seconds: short, so the sound and the pictures
// interleave closely.
const AUDIO_CHUNK: f64 = 0.1;

// How far the sound pushed runs ahead of the frames: the muxer interleaves
// the two, and sound far ahead would wait in it for the frames.
const AUDIO_AHEAD: f64 = 0.5;

// How long the file may take to finish once everything's in.
const STALL: gst::ClockTime = gst::ClockTime::from_seconds(60);

// The encoders, best first: VA-API's in hardware, newer then older, then
// software.
const H264_ENCODERS: [&str; 4] = ["vah264enc", "vaapih264enc", "x264enc", "openh264enc"];
const HEVC_ENCODERS: [&str; 3] = ["vah265enc", "vaapih265enc", "x265enc"];
const AAC_ENCODERS: [&str; 4] = ["fdkaacenc", "avenc_aac", "voaacenc", "faac"];

/// Whether H.264 and HEVC take a constant quality here: not yet.
pub fn constant_quality() -> bool {
    false
}

fn encoders(codec: VideoCodec) -> &'static [&'static str] {
    match codec {
        VideoCodec::Avc => &H264_ENCODERS,
        VideoCodec::Hevc => &HEVC_ENCODERS,
        VideoCodec::ProRes | VideoCodec::ProResHq | VideoCodec::Av1 => &[],
    }
}

/// What the native export makes on this computer: the codecs it has
/// encoders for, in MP4.
pub fn capabilities() -> Capabilities {
    let can_mux = first_element(&["mp4mux"]).is_some();
    let video_codecs = [VideoCodec::Avc, VideoCodec::Hevc]
        .into_iter()
        .filter(|&codec| can_mux && first_element(encoders(codec)).is_some())
        .collect();
    Capabilities {
        formats: vec![Container::Mp4],
        video_codecs,
        constant_quality: constant_quality(),
        audio_copy: can_mux && first_element(&["aacparse"]).is_some(),
        // As timed text (tx3g), which mp4mux writes, as on a Mac.
        subtitle_tracks: can_mux,
    }
}

/// A frame for the encoder: BGRA, top row first, in GStreamer's memory.
pub struct FrameMemory {
    buffer: RefCell<gst::Buffer>,
    size: (u32, u32),
}

impl FrameBuffer for FrameMemory {
    fn write(&self, data: &[u8], row: usize) -> Result<(), String> {
        let (width, height) = (self.size.0 as usize, self.size.1 as usize);
        let length = width * 4;
        if data.len() < row * (height - 1) + length {
            return Err("the encoder's buffer isn't the frame's size".into());
        }
        let mut buffer = self.buffer.borrow_mut();
        let buffer = buffer.get_mut().ok_or("the frame's buffer is in use")?;
        let mut target = buffer.map_writable().map_err(|error| error.to_string())?;
        for (y, line) in target.chunks_exact_mut(length).enumerate().take(height) {
            line.copy_from_slice(&data[y * row..y * row + length]);
        }
        Ok(())
    }
}

/// The mix, held until the frames are near: 16-bit, interleaved.
struct Sound {
    source: AppSrc,
    settings: AudioSettings,
    queued: VecDeque<i16>,
    /// Sample frames pushed so far.
    pushed: u64,
    /// Whether the mix has all come.
    is_complete: bool,
}

pub struct Writer {
    pipeline: gst::Pipeline,
    video: AppSrc,
    sound: Option<Sound>,
    size: (u32, u32),
    fps: (u32, u32),
    frames: u64,
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
    /// as timed text.
    pub fn with_subtitles(
        path: &Path,
        container: Container,
        video: &VideoSettings,
        audio: Option<Audio>,
        subtitles: &[SubtitleTrack],
    ) -> Result<Self, String> {
        if container != Container::Mp4 {
            return Err("Linux's own export makes only MP4 files".into());
        }
        let encoder = first_element(encoders(video.codec))
            .ok_or_else(|| format!("This computer can't encode {:?}", video.codec))?;
        let (audio, copy) = match audio {
            Some(Audio::Mix(settings)) => (Some(settings), None),
            Some(Audio::Copy { location, end }) => (None, Some((location, end))),
            None => (None, None),
        };
        let aac = match audio {
            Some(_) => {
                Some(first_element(&AAC_ENCODERS).ok_or("This computer has no AAC encoder")?)
            }
            None => None,
        };
        let parser = if video.codec == VideoCodec::Avc {
            "h264parse"
        } else {
            "h265parse"
        };
        let size = (video.width, video.height);
        let fps = (video.fps.numerator, video.fps.denominator);
        // Each stream queued before the muxer, which interleaves them; HD's
        // colours, which the editor's pictures are in. Three frames wait at
        // most to be encoded.
        let frame_bytes = u64::from(size.0) * u64::from(size.1) * 4;
        let mut description = format!(
            "appsrc name=video format=time block=true max-bytes={} ! videoconvert ! \
             video/x-raw,colorimetry=bt709 ! {encoder} name=encoder ! {parser} ! \
             queue max-size-buffers=0 max-size-bytes=0 max-size-time=10000000000 ! \
             mp4mux name=mux ! filesink name=sink",
            frame_bytes * 3
        );
        if let Some(aac) = aac {
            description.push_str(&format!(
                " appsrc name=audio format=time block=true max-bytes=4000000 ! audioconvert ! \
                 {aac} name=aac ! aacparse ! \
                 queue max-size-buffers=0 max-size-bytes=0 max-size-time=10000000000 ! mux."
            ));
        }
        // A file's sound as it's stored, read as fast as the frames take it.
        if copy.is_some() {
            description.push_str(
                " filesrc name=soundfile ! qtdemux name=sounddemux sounddemux.audio_0 ! \
                 aacparse name=copied ! \
                 queue max-size-buffers=0 max-size-bytes=0 max-size-time=10000000000 ! \
                 mux.audio_%u",
            );
        }
        // Each subtitle track's lines all at once, waiting unbounded for the
        // frames they go with: they're small.
        for index in 0..subtitles.len() {
            description.push_str(&format!(
                " appsrc name=subtitles{index} format=time \
                 caps=text/x-raw,format=utf8 ! \
                 queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! mux.subtitle_%u"
            ));
        }
        let pipeline = launch(&description)?;
        let sink = pipeline.by_name("sink").ok_or("no sink")?;
        sink.set_property("location", path.to_str().ok_or("not a UTF-8 path")?);
        configure_encoder(&pipeline, encoder, video, fps)?;

        let video_source: AppSrc = by_name(&pipeline, "video")?;
        let info = VideoInfo::builder(VideoFormat::Bgra, size.0, size.1)
            .fps(gst::Fraction::new(fps.0 as i32, fps.1 as i32))
            .build()
            .map_err(|error| error.to_string())?;
        video_source.set_caps(Some(&info.to_caps().map_err(|error| error.to_string())?));
        let sound = match audio {
            Some(settings) => {
                let source: AppSrc = by_name(&pipeline, "audio")?;
                let mut caps = gst::Caps::builder("audio/x-raw")
                    .field("format", "S16LE")
                    .field("layout", "interleaved")
                    .field("rate", settings.sample_rate as i32)
                    .field("channels", settings.channels as i32);
                // 5.1 in the web's order, which is GStreamer's: front left
                // and right, centre, LFE, then the surrounds.
                if settings.channels > 2 {
                    let mask = (1u64 << settings.channels) - 1;
                    caps = caps.field("channel-mask", gst::Bitmask::new(mask));
                }
                source.set_caps(Some(&caps.build()));
                let aac = pipeline.by_name("aac").ok_or("no AAC encoder")?;
                if aac.find_property("bitrate").is_some() {
                    aac.set_property_from_str("bitrate", &settings.bitrate.to_string());
                }
                Some(Sound {
                    source,
                    settings,
                    queued: VecDeque::new(),
                    pushed: 0,
                    is_complete: false,
                })
            }
            None => None,
        };
        if let Some((location, end)) = copy {
            let file = pipeline.by_name("soundfile").ok_or("no sound file")?;
            file.set_property("location", location.to_str().ok_or("not a UTF-8 path")?);
            copy_until(&pipeline, clock_time(end))?;
        }
        let writer = Self {
            pipeline,
            video: video_source,
            sound,
            size,
            fps,
            frames: 0,
        };
        play(&writer.pipeline)?;
        for (index, track) in subtitles.iter().enumerate() {
            let source: AppSrc = by_name(&writer.pipeline, &format!("subtitles{index}"))?;
            for (start, end, text) in timed_text::samples(&track.cues) {
                let mut buffer = gst::Buffer::from_mut_slice(text.into_bytes());
                {
                    let buffer = buffer.get_mut().ok_or("a subtitle's buffer is in use")?;
                    buffer.set_pts(clock_time(start));
                    buffer.set_duration(clock_time(end - start));
                }
                source
                    .push_buffer(buffer)
                    .map_err(|_| writer.failure("Couldn't write the subtitles"))?;
            }
            let _ = source.end_of_stream();
        }
        Ok(writer)
    }

    /// A buffer for the next frame.
    pub fn pixel_buffer(&self) -> Result<FrameMemory, String> {
        let length = (self.size.0 * self.size.1 * 4) as usize;
        let buffer = gst::Buffer::with_size(length).map_err(|error| error.to_string())?;
        Ok(FrameMemory {
            buffer: RefCell::new(buffer),
            size: self.size,
        })
    }

    /// When frame `index` starts.
    fn frame_time(&self, index: u64) -> gst::ClockTime {
        let (numerator, denominator) = (u64::from(self.fps.0), u64::from(self.fps.1));
        gst::ClockTime::from_nseconds(index * denominator * 1_000_000_000 / numerator)
    }

    /// Adds the next frame: it waits while the encoder's behind.
    pub fn add_frame(&mut self, frame: &FrameMemory) -> Result<(), String> {
        let time = self.frame_time(self.frames);
        let next = self.frame_time(self.frames + 1);
        let mut buffer = frame.buffer.replace(gst::Buffer::new());
        {
            let buffer = buffer.get_mut().ok_or("the frame's buffer is in use")?;
            buffer.set_pts(time);
            buffer.set_duration(next - time);
        }
        self.video
            .push_buffer(buffer)
            .map_err(|_| self.failure("Couldn't encode a frame"))?;
        self.frames += 1;
        self.push_sound(next.nseconds() as f64 / 1e9 + AUDIO_AHEAD)
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
        let shown = self.frame_time(self.frames).nseconds() as f64 / 1e9;
        self.push_sound(shown + AUDIO_AHEAD)
    }

    /// Pushes the sound held, up to `until` seconds.
    fn push_sound(&mut self, until: f64) -> Result<(), String> {
        let Some(sound) = &mut self.sound else {
            return Ok(());
        };
        let channels = sound.settings.channels as usize;
        let rate = u64::from(sound.settings.sample_rate);
        let chunk = (AUDIO_CHUNK * rate as f64) as usize;
        while (sound.pushed as f64) < until * rate as f64 {
            let held = sound.queued.len() / channels;
            // A short last piece only once the mix is over.
            let count = if held >= chunk || (sound.is_complete && held > 0) {
                held.min(chunk)
            } else {
                break;
            };
            let bytes: Vec<u8> = sound
                .queued
                .drain(..count * channels)
                .flat_map(i16::to_le_bytes)
                .collect();
            let mut buffer = gst::Buffer::from_mut_slice(bytes);
            let time = gst::ClockTime::from_nseconds(sound.pushed * 1_000_000_000 / rate);
            let end =
                gst::ClockTime::from_nseconds((sound.pushed + count as u64) * 1_000_000_000 / rate);
            {
                let buffer = buffer.get_mut().ok_or("the sound's buffer is in use")?;
                buffer.set_pts(time);
                buffer.set_duration(end - time);
            }
            if sound.source.push_buffer(buffer).is_err() {
                return Err(
                    failure(&self.pipeline).unwrap_or_else(|| "Couldn't write the sound".into())
                );
            }
            sound.pushed += count as u64;
        }
        Ok(())
    }

    /// Finishes the file, with all the sound held.
    pub fn finish(mut self) -> Result<(), String> {
        if let Some(sound) = &mut self.sound {
            sound.is_complete = true;
        }
        self.push_sound(f64::INFINITY)?;
        let _ = self.video.end_of_stream();
        if let Some(sound) = &self.sound {
            let _ = sound.source.end_of_stream();
        }
        let bus = self.pipeline.bus().ok_or("the pipeline has no bus")?;
        let ended =
            bus.timed_pop_filtered(STALL, &[gst::MessageType::Eos, gst::MessageType::Error]);
        let result = match ended.as_ref().map(|message| message.view()) {
            Some(gst::MessageView::Eos(_)) => Ok(()),
            Some(gst::MessageView::Error(error)) => {
                Err(format!("Couldn't finish the file: {}", error.error()))
            }
            _ => Err("The file took too long to finish".into()),
        };
        let _ = self.pipeline.set_state(gst::State::Null);
        result
    }

    /// Stops, leaving the file for the caller to delete.
    pub fn cancel(self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }

    fn failure(&self, doing: &str) -> String {
        match failure(&self.pipeline) {
            Some(error) => format!("{doing}: {error}"),
            None => doing.to_owned(),
        }
    }
}

/// Copied sound ends where the timeline stops hearing it: the first packet
/// from `end` on is refused, as is all that follows, so the demuxer stops
/// reading the file there.
fn copy_until(pipeline: &gst::Pipeline, end: gst::ClockTime) -> Result<(), String> {
    let parser = pipeline
        .by_name("copied")
        .ok_or("no parser for the copied sound")?;
    let pad = parser.static_pad("src").ok_or("the parser has no output")?;
    pad.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        let is_late = matches!(
            &info.data,
            Some(gst::PadProbeData::Buffer(buffer)) if buffer.pts().is_some_and(|pts| pts >= end)
        );
        if !is_late {
            return gst::PadProbeReturn::Ok;
        }
        pad.push_event(gst::event::Eos::new());
        gst::PadProbeReturn::Remove
    });
    Ok(())
}

/// The bitrate, a key frame every two seconds, and a quick preset, in each
/// encoder's own terms.
fn configure_encoder(
    pipeline: &gst::Pipeline,
    name: &str,
    video: &VideoSettings,
    fps: (u32, u32),
) -> Result<(), String> {
    let encoder = pipeline.by_name("encoder").ok_or("no encoder")?;
    let set = |property: &str, value: &str| {
        if encoder.find_property(property).is_some() {
            encoder.set_property_from_str(property, value);
        }
    };
    // OpenH264 counts bits a second; the others, thousands.
    let bitrate = if name == "openh264enc" {
        video.bitrate
    } else {
        (video.bitrate / 1000).max(1)
    };
    set("bitrate", &bitrate.to_string());
    let interval = (f64::from(fps.0) / f64::from(fps.1) * KEY_FRAME_INTERVAL).round() as u32;
    let interval = interval.max(1).to_string();
    match name {
        "vaapih264enc" | "vaapih265enc" => set("keyframe-period", &interval),
        "openh264enc" => set("gop-size", &interval),
        _ => set("key-int-max", &interval),
    }
    if name == "x264enc" || name == "x265enc" {
        set("speed-preset", "fast");
    }
    Ok(())
}
