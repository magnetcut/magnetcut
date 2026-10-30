// A source's pictures on Linux, decoded by GStreamer (in hardware where
// there's a VA-API decoder for the codec) and turned into BGRA, in the order
// the export asks for them: as `decode.rs` does with AVFoundation on macOS.

use std::path::Path;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSink;
use gstreamer_video::{VideoFrameRef, VideoInfo};

use super::frames::{Picture, Pixels};
use super::pipeline::{by_name, clock_time, failure, launch, seconds, set_state};
use super::settings::SourceInfo;
use super::turn::Turner;

// The tolerance between a time asked for and a frame's: far under a frame.
const EPSILON: f64 = 1e-4;

// How far ahead decoding on is quicker than seeking.
const SEEK_AHEAD: f64 = 2.0;

// Reading starts at least this long before a source's end, so as to find its
// last frame, which starts before the end by its own duration.
const LAST_SEEK: f64 = 1.0;

// The file's first pictures, decoded by whatever the system has for them,
// as BGRA; a few decoded ahead, no more.
const DESCRIPTION: &str = "filesrc name=source ! decodebin ! videoconvert ! \
    appsink name=frames sync=false max-buffers=4 caps=video/x-raw,format=BGRA";

/// What a source is, if GStreamer can decode its pictures.
pub fn probe(location: &Path) -> Result<Option<SourceInfo>, String> {
    // A file it can't open or decode is one the web view's export may manage.
    let Ok(source) = Source::open(location) else {
        return Ok(None);
    };
    let (width, height) = Turner::shown_size(source.size, source.rotation);
    Ok(Some(SourceInfo {
        width,
        height,
        rotation: source.rotation,
    }))
}

/// A source opened for its pictures.
struct Source {
    pipeline: gst::Pipeline,
    frames: AppSink,
    size: (u32, u32),
    rotation: u32,
    /// In seconds.
    duration: f64,
}

impl Source {
    fn open(location: &Path) -> Result<Self, String> {
        let pipeline = launch(DESCRIPTION)?;
        let file = pipeline.by_name("source").ok_or("no source")?;
        file.set_property("location", location.to_str().ok_or("not a UTF-8 path")?);
        let frames: AppSink = by_name(&pipeline, "frames")?;
        // Stopped when dropped, should it go no further.
        let mut source = Self {
            pipeline,
            frames,
            size: (0, 0),
            rotation: 0,
            duration: 0.0,
        };
        // Paused, it decodes the first picture: what it is, and its size.
        set_state(&source.pipeline, gst::State::Paused)?;
        let first = source.frames.pull_preroll().map_err(|_| {
            failure(&source.pipeline).unwrap_or_else(|| "the file has no pictures".into())
        })?;
        let info = VideoInfo::from_caps(first.caps().ok_or("a picture of no kind")?)
            .map_err(|error| error.to_string())?;
        source.size = (info.width(), info.height());
        source.rotation = rotation(&source.pipeline);
        source.duration = source
            .pipeline
            .query_duration::<gst::ClockTime>()
            .map(seconds)
            .unwrap_or(0.0);
        Ok(source)
    }

    /// Reading on from the key frame before `time`: the frames before it
    /// come first.
    fn seek(&self, time: f64) -> Result<(), String> {
        let flags = gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT | gst::SeekFlags::SNAP_BEFORE;
        self.pipeline
            .seek_simple(flags, clock_time(time))
            .map_err(|_| failure(&self.pipeline).unwrap_or_else(|| "couldn't seek a source".into()))
    }

    /// The next frame, None at the end.
    fn read(&self) -> Result<Option<Frame>, String> {
        let Ok(sample) = self.frames.pull_sample() else {
            if self.frames.is_eos() {
                return Ok(None);
            }
            return Err(
                failure(&self.pipeline).unwrap_or_else(|| "Couldn't decode a source".into())
            );
        };
        let buffer = sample.buffer().ok_or("a sample with no picture")?;
        let pts = buffer.pts().ok_or("a picture with no time")?;
        // The file's own time, as the editor counts it.
        let time = sample
            .segment()
            .and_then(|segment| segment.downcast_ref::<gst::ClockTime>())
            .and_then(|segment| segment.to_stream_time(pts))
            .unwrap_or(pts);
        let info = VideoInfo::from_caps(sample.caps().ok_or("a picture of no kind")?)
            .map_err(|error| error.to_string())?;
        Ok(Some(Frame {
            time: seconds(time),
            picture: Decoded { sample, info },
        }))
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// How the file says its pictures are turned to be shown: clockwise, in
/// degrees, from the tags GStreamer read as it opened it.
fn rotation(pipeline: &gst::Pipeline) -> u32 {
    let Some(bus) = pipeline.bus() else {
        return 0;
    };
    let mut rotation = 0;
    while let Some(message) = bus.pop_filtered(&[gst::MessageType::Tag]) {
        if let gst::MessageView::Tag(tag) = message.view()
            && let Some(orientation) = tag.tags().get::<gst::tags::ImageOrientation>()
        {
            // "rotate-90", or flipped first ("flip-rotate-90"): the flip is
            // left as it is.
            rotation = match orientation.get().rsplit('-').next() {
                Some("90") => 90,
                Some("180") => 180,
                Some("270") => 270,
                _ => 0,
            };
        }
    }
    rotation
}

/// A decoded picture, in GStreamer's buffer.
pub struct Decoded {
    sample: gst::Sample,
    info: VideoInfo,
}

impl Picture for Decoded {
    fn read<T>(&self, read: impl FnOnce(&Pixels<'_>) -> T) -> Result<T, String> {
        let buffer = self.sample.buffer().ok_or("a sample with no picture")?;
        let frame = VideoFrameRef::from_buffer_ref_readable(buffer, &self.info)
            .map_err(|error| error.to_string())?;
        let data = frame.plane_data(0).map_err(|error| error.to_string())?;
        let stride = frame.plane_stride()[0];
        if stride <= 0 {
            return Err("a decoded picture stored upside down".into());
        }
        Ok(read(&Pixels {
            width: frame.width(),
            height: frame.height(),
            bytes_per_row: stride as u32,
            data,
        }))
    }
}

struct Frame {
    time: f64,
    picture: Decoded,
}

/// A source's frames from a time on: the one showing at each time asked,
/// each later than the last, or a seek.
pub struct VideoReader {
    source: Source,
    /// Where reading started, and the frames either side of the time last asked.
    start: f64,
    current: Option<Frame>,
    next: Option<Frame>,
    is_done: bool,
    /// Where reading may start and still find a frame: before the last.
    latest_start: f64,
}

impl VideoReader {
    pub fn open(location: &Path, time: f64) -> Result<Self, String> {
        let source = Source::open(location)?;
        let latest_start = (source.duration - LAST_SEEK).max(0.0);
        let time = time.min(latest_start);
        if time > 0.0 {
            source.seek(time)?;
        }
        set_state(&source.pipeline, gst::State::Playing)?;
        Ok(Self {
            source,
            start: time,
            current: None,
            next: None,
            is_done: false,
            latest_start,
        })
    }

    /// How its pictures are turned to be shown: clockwise, in degrees.
    pub fn rotation(&self) -> u32 {
        self.source.rotation
    }

    /// The frame showing at `time`: the last one to start by then, or the
    /// first if none has. None if the source has no frames at all.
    pub fn frame_at(&mut self, time: f64) -> Result<Option<(f64, &Decoded)>, String> {
        let current_time = self.current.as_ref().map(|frame| frame.time);
        let is_behind = time + EPSILON < current_time.unwrap_or(self.start);
        let is_far_ahead = current_time.is_some_and(|current| time > current + SEEK_AHEAD);
        if is_behind || is_far_ahead {
            self.seek(time)?;
        }
        if self.current.is_none() && self.next.is_none() {
            self.next = self.read()?;
        }
        while let Some(next) = self.next.take() {
            if next.time > time + EPSILON && self.current.is_some() {
                self.next = Some(next);
                break;
            }
            self.current = Some(next);
            self.next = self.read()?;
        }
        Ok(self
            .current
            .as_ref()
            .map(|frame| (frame.time, &frame.picture)))
    }

    fn seek(&mut self, time: f64) -> Result<(), String> {
        // Past the end, from before the last frame, to show it.
        let time = time.min(self.latest_start);
        self.source.seek(time)?;
        self.start = time;
        self.current = None;
        self.next = None;
        self.is_done = false;
        Ok(())
    }

    fn read(&mut self) -> Result<Option<Frame>, String> {
        if self.is_done {
            return Ok(None);
        }
        let frame = self.source.read()?;
        self.is_done = frame.is_none();
        Ok(frame)
    }
}
