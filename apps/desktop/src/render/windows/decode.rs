// A source's pictures on Windows, decoded by Media Foundation's source reader
// and turned into BGRA by its video processing, in the order the export asks
// for them: as `decode.rs` does with AVFoundation on macOS.

use std::mem::ManuallyDrop;
use std::path::Path;

use windows::Win32::Media::MediaFoundation::{
    IMFMediaBuffer, IMFMediaType, IMFSample, IMFSourceReader, MF_MT_DEFAULT_STRIDE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_SUBTYPE,
    MF_MT_VIDEO_ROTATION, MF_PD_DURATION, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_SOURCE_READER_MEDIASOURCE, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR, MFCreateMediaType,
    MFCreateSourceReaderFromURL, MFMediaType_Video, MFVideoFormat_RGB32,
};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Variant::VT_I8;
use windows::core::{GUID, PCWSTR};

use super::frames::{Picture, Pixels};
use super::media_foundation::{TICKS_PER_SECOND, attributes, start, text, unpair, wide};
use super::settings::SourceInfo;
use super::turn::Turner;

// The tolerance between a time asked for and a frame's: far under a frame.
const EPSILON: f64 = 1e-4;

// How far ahead decoding on is quicker than seeking.
const SEEK_AHEAD: f64 = 2.0;

// Reading starts at least this long before a source's end, so as to find its
// last frame, which starts before the end by its own duration.
const LAST_SEEK: f64 = 1.0;

const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

/// What a source is, if Media Foundation can decode its pictures.
pub fn probe(location: &Path) -> Result<Option<SourceInfo>, String> {
    // A file it can't open or decode is one the web view's export may manage.
    let Ok(source) = Source::open(location) else {
        return Ok(None);
    };
    let size = (source.format.width, source.format.height);
    let (width, height) = Turner::shown_size(size, source.rotation);
    Ok(Some(SourceInfo {
        width,
        height,
        rotation: source.rotation,
    }))
}

/// How the decoded pictures are laid out.
#[derive(Clone, Copy)]
struct Format {
    /// The picture shown, which may be less than what's decoded.
    width: u32,
    height: u32,
    left: u32,
    top: u32,
    /// Bytes a row, negative where the picture's stored bottom row first.
    stride: i32,
}

impl Format {
    fn of(media_type: &IMFMediaType) -> Result<Self, String> {
        let (width, height) =
            unpair(unsafe { media_type.GetUINT64(&MF_MT_FRAME_SIZE) }.map_err(text)?);
        let stride = unsafe { media_type.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
            .map(|stride| stride as i32)
            .unwrap_or(width as i32 * 4);
        let mut format = Self {
            width,
            height,
            left: 0,
            top: 0,
            stride,
        };
        // A picture coded in blocks of 16 shows less of them: 1080 of 1088 rows.
        let mut area = [0u8; 16];
        if unsafe { media_type.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, &mut area, None) }.is_ok() {
            let number = |at: usize| {
                i32::from_le_bytes([area[at], area[at + 1], area[at + 2], area[at + 3]])
            };
            let offset = |at: usize| i16::from_le_bytes([area[at + 2], area[at + 3]]);
            let (left, top) = (offset(0).max(0) as u32, offset(4).max(0) as u32);
            let (shown_width, shown_height) = (number(8).max(0) as u32, number(12).max(0) as u32);
            if shown_width > 0
                && shown_height > 0
                && left + shown_width <= width
                && top + shown_height <= height
            {
                format = Self {
                    width: shown_width,
                    height: shown_height,
                    left,
                    top,
                    stride,
                };
            }
        }
        Ok(format)
    }
}

/// A source opened for its pictures.
struct Source {
    reader: IMFSourceReader,
    format: Format,
    rotation: u32,
    /// In seconds.
    duration: f64,
}

impl Source {
    fn open(location: &Path) -> Result<Self, String> {
        start()?;
        let url = wide(location)?;
        // Its video processing turns whatever's decoded into BGRA.
        let settings = attributes(&[(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)], &[])?;
        let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), &settings) }
            .map_err(text)?;
        // Only the pictures: a stream selected and not read would pile up.
        unsafe {
            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .map_err(text)?;
            reader.SetStreamSelection(VIDEO, true).map_err(text)?;
        }
        let native = unsafe { reader.GetNativeMediaType(VIDEO, 0) }.map_err(text)?;
        // Clockwise, as the content is stored turned counter-clockwise by as
        // much (MFVideoRotationFormat).
        let rotation = unsafe { native.GetUINT32(&MF_MT_VIDEO_ROTATION) }.unwrap_or(0) % 360;
        let wanted = unsafe { MFCreateMediaType() }.map_err(text)?;
        unsafe {
            wanted
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(text)?;
            wanted
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .map_err(text)?;
            reader
                .SetCurrentMediaType(VIDEO, None, &wanted)
                .map_err(text)?;
        }
        let format = Format::of(&unsafe { reader.GetCurrentMediaType(VIDEO) }.map_err(text)?)?;
        let duration = unsafe {
            reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
        }
        .map(|value| unsafe { value.Anonymous.Anonymous.Anonymous.uhVal } as f64)
        .unwrap_or(0.0)
            / TICKS_PER_SECOND as f64;
        Ok(Self {
            reader,
            format,
            rotation,
            duration,
        })
    }

    /// Reading on from the key frame before `time`: the frames before it
    /// come first.
    fn seek(&self, time: f64) -> Result<(), String> {
        let ticks = (time.max(0.0) * TICKS_PER_SECOND as f64) as i64;
        let position = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_I8,
                    Anonymous: PROPVARIANT_0_0_0 { hVal: ticks },
                    ..Default::default()
                }),
            },
        };
        unsafe { self.reader.SetCurrentPosition(&GUID::zeroed(), &position) }.map_err(text)
    }

    /// The next frame, None at the end.
    fn read(&mut self) -> Result<Option<Frame>, String> {
        loop {
            let mut flags = 0u32;
            let mut time = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                self.reader.ReadSample(
                    VIDEO,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut time),
                    Some(&mut sample),
                )
            }
            .map_err(text)?;
            let has = |flag: i32| flags & flag as u32 != 0;
            if has(MF_SOURCE_READERF_ERROR.0) {
                return Err("Couldn't decode a source".into());
            }
            if has(MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0) {
                let current = unsafe { self.reader.GetCurrentMediaType(VIDEO) }.map_err(text)?;
                self.format = Format::of(&current)?;
            }
            if has(MF_SOURCE_READERF_ENDOFSTREAM.0) {
                return Ok(None);
            }
            // A gap in the stream, with no picture.
            let Some(sample) = sample else {
                continue;
            };
            let buffer = unsafe { sample.ConvertToContiguousBuffer() }.map_err(text)?;
            return Ok(Some(Frame {
                time: time as f64 / TICKS_PER_SECOND as f64,
                picture: Decoded {
                    buffer,
                    format: self.format,
                },
            }));
        }
    }
}

/// A decoded picture, in Media Foundation's buffer.
pub struct Decoded {
    buffer: IMFMediaBuffer,
    format: Format,
}

impl Picture for Decoded {
    fn read<T>(&self, read: impl FnOnce(&Pixels<'_>) -> T) -> Result<T, String> {
        let Format {
            width,
            height,
            left,
            top,
            stride,
        } = self.format;
        let mut data = std::ptr::null_mut();
        let mut length = 0u32;
        unsafe { self.buffer.Lock(&mut data, None, Some(&mut length)) }.map_err(text)?;
        // SAFETY: locked, the buffer holds `length` bytes.
        let stored = unsafe { std::slice::from_raw_parts(data, length as usize) };
        let row = stride.unsigned_abs() as usize;
        let (width, height) = (width as usize, height as usize);
        let rows = top as usize + height;
        let result = if stored.len() < row * (rows - 1) + (left as usize + width) * 4 {
            Err("a decoded picture is smaller than it says".to_owned())
        } else {
            // Top row first, and opaque: RGB32's fourth byte isn't alpha.
            let mut pixels = vec![0u8; width * height * 4];
            for (y, line) in pixels.chunks_exact_mut(width * 4).enumerate() {
                let y = top as usize + y;
                let stored_y = if stride < 0 { rows - 1 - y } else { y };
                let at = stored_y * row + left as usize * 4;
                line.copy_from_slice(&stored[at..at + width * 4]);
                for pixel in line.as_chunks_mut::<4>().0 {
                    pixel[3] = 255;
                }
            }
            Ok(read(&Pixels {
                width: width as u32,
                height: height as u32,
                bytes_per_row: (width * 4) as u32,
                data: &pixels,
            }))
        };
        unsafe { self.buffer.Unlock() }.map_err(text)?;
        result
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
