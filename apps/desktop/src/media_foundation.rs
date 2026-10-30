// Media Foundation, Windows's media framework, for the native export there
// (docs/NATIVE.md, phase 5): which encoders the system has, a writer of H.264
// and AAC in MP4, and a reader of a file's pictures as BGRA.

use std::path::Path;

use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFByteStream, IMFMediaType, IMFSample, IMFSinkWriter,
    IMFSourceReader, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateAttributes, MFCreateMediaType,
    MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL,
    MFMediaType_Audio, MFMediaType_Video, MFSTARTUP_FULL, MFStartup, MFT_ENUM_FLAG_ALL,
    MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264,
    MFVideoFormat_RGB32, MFVideoInterlace_Progressive,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree};
use windows::core::{GUID, PCWSTR, PWSTR};

// Media Foundation counts time in hundreds of nanoseconds.
const TICKS_PER_SECOND: i64 = 10_000_000;

fn text(error: windows::core::Error) -> String {
    error.to_string()
}

/// Starts COM on this thread and Media Foundation for the process: once is
/// enough, more is fine.
pub fn start() -> Result<(), String> {
    // Already started, perhaps otherwise: Media Foundation runs either way.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(text)
}

/// A path as Windows takes it: UTF-16, ending in a nul.
fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let path = path.to_str().ok_or("not a UTF-8 path")?;
    Ok(path.encode_utf16().chain([0]).collect())
}

fn attributes(settings: &[(GUID, u32)]) -> Result<IMFAttributes, String> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, settings.len() as u32) }.map_err(text)?;
    let attributes = attributes.ok_or("no attributes")?;
    for (key, value) in settings {
        unsafe { attributes.SetUINT32(key, *value) }.map_err(text)?;
    }
    Ok(attributes)
}

/// Two numbers as one, as Media Foundation packs a size or a rate.
fn pair(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// Pictures of this size and rate, in `subtype`, at `bitrate` if encoded.
fn video_type(
    subtype: GUID,
    (width, height): (u32, u32),
    (numerator, denominator): (u32, u32),
    bitrate: Option<u32>,
) -> Result<IMFMediaType, String> {
    let media_type = unsafe { MFCreateMediaType() }.map_err(text)?;
    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(text)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(text)?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, pair(width, height))
            .map_err(text)?;
        media_type
            .SetUINT64(&MF_MT_FRAME_RATE, pair(numerator, denominator))
            .map_err(text)?;
        media_type
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pair(1, 1))
            .map_err(text)?;
        if let Some(bitrate) = bitrate {
            media_type
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                .map_err(text)?;
        }
    }
    Ok(media_type)
}

/// Sound in `subtype`: AAC at `bitrate`, else 16-bit samples.
fn audio_type(
    subtype: GUID,
    channels: u32,
    sample_rate: u32,
    bitrate: Option<u32>,
) -> Result<IMFMediaType, String> {
    let media_type = unsafe { MFCreateMediaType() }.map_err(text)?;
    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(text)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)
            .map_err(text)?;
        match bitrate {
            Some(bitrate) => media_type
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bitrate / 8)
                .map_err(text)?,
            None => {
                media_type
                    .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * 2)
                    .map_err(text)?;
                media_type
                    .SetUINT32(
                        &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                        sample_rate * channels * 2,
                    )
                    .map_err(text)?;
            }
        }
    }
    Ok(media_type)
}

/// A sample of these bytes, at `time` for `duration`, in hundreds of
/// nanoseconds.
fn sample(
    fill: impl FnOnce(&mut [u8]),
    length: usize,
    time: i64,
    duration: i64,
) -> Result<IMFSample, String> {
    let buffer = unsafe { MFCreateMemoryBuffer(length as u32) }.map_err(text)?;
    let mut data = std::ptr::null_mut();
    unsafe { buffer.Lock(&mut data, None, None) }.map_err(text)?;
    // SAFETY: locked, the buffer holds `length` bytes.
    fill(unsafe { std::slice::from_raw_parts_mut(data, length) });
    unsafe {
        buffer.Unlock().map_err(text)?;
        buffer.SetCurrentLength(length as u32).map_err(text)?;
    }
    let sample = unsafe { MFCreateSample() }.map_err(text)?;
    unsafe {
        sample.AddBuffer(&buffer).map_err(text)?;
        sample.SetSampleTime(time).map_err(text)?;
        sample.SetSampleDuration(duration).map_err(text)?;
    }
    Ok(sample)
}

/// A film written by Media Foundation's sink writer: H.264 from BGRA frames
/// and AAC from the mix, in MP4, in hardware where there's an encoder.
pub struct Writer {
    writer: IMFSinkWriter,
    video: u32,
    audio: Option<(u32, u32, u32)>,
    size: (u32, u32),
    fps: (u32, u32),
    frames: i64,
    sound_frames: i64,
}

impl Writer {
    /// A file at `path`; sound as (channels, sample rate, bitrate), if any.
    pub fn new(
        path: &Path,
        size: (u32, u32),
        fps: (u32, u32),
        bitrate: u32,
        audio: Option<(u32, u32, u32)>,
    ) -> Result<Self, String> {
        start()?;
        let url = wide(path)?;
        let settings = attributes(&[(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)])?;
        let writer = unsafe {
            MFCreateSinkWriterFromURL(PCWSTR(url.as_ptr()), None::<&IMFByteStream>, &settings)
        }
        .map_err(text)?;
        let encoded = video_type(MFVideoFormat_H264, size, fps, Some(bitrate))?;
        let video = unsafe { writer.AddStream(&encoded) }.map_err(text)?;
        let frames = video_type(MFVideoFormat_RGB32, size, fps, None)?;
        // Rows top first.
        unsafe { frames.SetUINT32(&MF_MT_DEFAULT_STRIDE, size.0 * 4) }.map_err(text)?;
        unsafe { writer.SetInputMediaType(video, &frames, None::<&IMFAttributes>) }
            .map_err(text)?;
        let audio = match audio {
            Some((channels, sample_rate, bitrate)) => {
                let encoded = audio_type(MFAudioFormat_AAC, channels, sample_rate, Some(bitrate))?;
                let stream = unsafe { writer.AddStream(&encoded) }.map_err(text)?;
                let samples = audio_type(MFAudioFormat_PCM, channels, sample_rate, None)?;
                unsafe { writer.SetInputMediaType(stream, &samples, None::<&IMFAttributes>) }
                    .map_err(text)?;
                Some((stream, channels, sample_rate))
            }
            None => None,
        };
        unsafe { writer.BeginWriting() }.map_err(text)?;
        Ok(Self {
            writer,
            video,
            audio,
            size,
            fps,
            frames: 0,
            sound_frames: 0,
        })
    }

    /// The next frame: BGRA, in rows of `row` bytes, top first.
    pub fn add_frame(&mut self, pixels: &[u8], row: usize) -> Result<(), String> {
        let (width, height) = (self.size.0 as usize, self.size.1 as usize);
        let (numerator, denominator) = (i64::from(self.fps.0), i64::from(self.fps.1));
        let time = self.frames * denominator * TICKS_PER_SECOND / numerator;
        let next = (self.frames + 1) * denominator * TICKS_PER_SECOND / numerator;
        let frame = sample(
            |data| {
                for (y, line) in data.chunks_exact_mut(width * 4).enumerate().take(height) {
                    line.copy_from_slice(&pixels[y * row..y * row + width * 4]);
                }
            },
            width * height * 4,
            time,
            next - time,
        )?;
        unsafe { self.writer.WriteSample(self.video, &frame) }.map_err(text)?;
        self.frames += 1;
        Ok(())
    }

    /// The mix's next samples: float, interleaved.
    pub fn add_audio(&mut self, samples: &[f32]) -> Result<(), String> {
        let Some((stream, channels, sample_rate)) = self.audio else {
            return Err("the film has no sound".into());
        };
        let count = samples.len() / channels as usize;
        if count == 0 {
            return Ok(());
        }
        let rate = i64::from(sample_rate);
        let time = self.sound_frames * TICKS_PER_SECOND / rate;
        let end = (self.sound_frames + count as i64) * TICKS_PER_SECOND / rate;
        let chunk = sample(
            |data| {
                for (bytes, value) in data.as_chunks_mut::<2>().0.iter_mut().zip(samples) {
                    let value = (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
                    *bytes = value.to_le_bytes();
                }
            },
            count * channels as usize * 2,
            time,
            end - time,
        )?;
        unsafe { self.writer.WriteSample(stream, &chunk) }.map_err(text)?;
        self.sound_frames += count as i64;
        Ok(())
    }

    /// Finishes the file.
    pub fn finish(self) -> Result<(), String> {
        unsafe { self.writer.Finalize() }.map_err(text)
    }
}

/// A file's pictures decoded by Media Foundation's source reader, as BGRA.
pub struct Reader {
    reader: IMFSourceReader,
    pub width: u32,
    pub height: u32,
    /// Bytes a row, negative where the picture's stored bottom row first.
    stride: i32,
}

impl Reader {
    pub fn open(path: &Path) -> Result<Self, String> {
        start()?;
        let url = wide(path)?;
        // Its video processing turns whatever's decoded into BGRA.
        let settings = attributes(&[(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)])?;
        let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), &settings) }
            .map_err(text)?;
        let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let wanted = unsafe { MFCreateMediaType() }.map_err(text)?;
        unsafe {
            wanted
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(text)?;
            wanted
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .map_err(text)?;
            reader
                .SetCurrentMediaType(stream, None, &wanted)
                .map_err(text)?;
        }
        let current = unsafe { reader.GetCurrentMediaType(stream) }.map_err(text)?;
        let size = unsafe { current.GetUINT64(&MF_MT_FRAME_SIZE) }.map_err(text)?;
        let (width, height) = ((size >> 32) as u32, size as u32);
        let stride = unsafe { current.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
            .map(|stride| stride as i32)
            .unwrap_or(width as i32 * 4);
        Ok(Self {
            reader,
            width,
            height,
            stride,
        })
    }

    /// The next frame: when it shows, in seconds, and its pixels, top row
    /// first, `width * 4` bytes a row. None at the end.
    pub fn next_frame(&mut self) -> Result<Option<(f64, Vec<u8>)>, String> {
        let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        loop {
            let mut flags = 0u32;
            let mut time = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                self.reader.ReadSample(
                    stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut time),
                    Some(&mut sample),
                )
            }
            .map_err(text)?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                return Ok(None);
            }
            let Some(sample) = sample else {
                continue;
            };
            let buffer = unsafe { sample.ConvertToContiguousBuffer() }.map_err(text)?;
            let mut data = std::ptr::null_mut();
            let mut length = 0u32;
            unsafe { buffer.Lock(&mut data, None, Some(&mut length)) }.map_err(text)?;
            let (width, height) = (self.width as usize, self.height as usize);
            let row = self.stride.unsigned_abs() as usize;
            // SAFETY: locked, the buffer holds `length` bytes.
            let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
            let mut pixels = vec![0u8; width * height * 4];
            for (y, line) in pixels.chunks_exact_mut(width * 4).enumerate() {
                let stored = if self.stride < 0 { height - 1 - y } else { y };
                let at = stored * row;
                if let Some(source) = bytes.get(at..at + width * 4) {
                    line.copy_from_slice(source);
                }
            }
            unsafe { buffer.Unlock() }.map_err(text)?;
            return Ok(Some((time as f64 / TICKS_PER_SECOND as f64, pixels)));
        }
    }
}

/// The names of the system's encoders of `category` (video or audio) that
/// make `subtype` (H.264, HEVC, AAC…), hardware ones first.
pub fn encoders(category: GUID, major: GUID, subtype: GUID) -> Result<Vec<String>, String> {
    start()?;
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: major,
        guidSubtype: subtype,
    };
    let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe {
        MFTEnumEx(
            category,
            MFT_ENUM_FLAG_ALL,
            None,
            Some(std::ptr::from_ref(&output)),
            &mut activates,
            &mut count,
        )
    }
    .map_err(|error| error.to_string())?;
    let mut names = Vec::new();
    if activates.is_null() {
        return Ok(names);
    }
    // SAFETY: MFTEnumEx gives `count` of them, for us to release and free.
    let list = unsafe { std::slice::from_raw_parts_mut(activates, count as usize) };
    for activate in list.iter_mut() {
        if let Some(activate) = activate.take() {
            let mut name = PWSTR::null();
            let mut length = 0u32;
            if unsafe {
                activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut length)
            }
            .is_ok()
            {
                names.push(unsafe { name.to_string() }.unwrap_or_default());
                unsafe { CoTaskMemFree(Some(name.0.cast_const().cast())) };
            }
        }
    }
    unsafe { CoTaskMemFree(Some(activates.cast_const().cast())) };
    Ok(names)
}

#[cfg(test)]
mod tests {
    use windows::Win32::Media::MediaFoundation::{
        MFAudioFormat_AAC, MFMediaType_Audio, MFMediaType_Video, MFT_CATEGORY_AUDIO_ENCODER,
        MFT_CATEGORY_VIDEO_ENCODER, MFVideoFormat_H264, MFVideoFormat_HEVC,
    };

    /// What this system has to encode with: printed, for the CI runners'.
    #[test]
    fn encodes_h264_and_aac_and_decodes_them_back() {
        let path = std::env::temp_dir().join(format!("magnetcut-mf-{}.mp4", std::process::id()));
        let mut writer = super::Writer::new(
            &path,
            (64, 64),
            (30, 1),
            1_000_000,
            Some((2, 44_100, 128_000)),
        )
        .unwrap();
        let tone: Vec<f32> = (0..44_100)
            .flat_map(|i| {
                let value = (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5;
                [value, value]
            })
            .collect();
        writer.add_audio(&tone).unwrap();
        for i in 0..30 {
            let grey = (i * 8) as u8;
            writer
                .add_frame(&[grey, grey, grey, 255].repeat(64 * 64), 64 * 4)
                .unwrap();
        }
        writer.finish().unwrap();

        let mut reader = super::Reader::open(&path).unwrap();
        assert_eq!((reader.width, reader.height), (64, 64));
        let mut frames = Vec::new();
        while let Some((time, pixels)) = reader.next_frame().unwrap() {
            frames.push((time, pixels[(32 * 64 + 32) * 4]));
        }
        assert_eq!(frames.len(), 30, "{frames:?}");
        let (time, grey) = frames[15];
        assert!((time - 0.5).abs() < 0.02, "{time}");
        assert!(grey.abs_diff(120) <= 8, "frame 15's grey {grey}");
    }

    #[test]
    fn lists_the_encoders() {
        for (name, category, major, subtype) in [
            (
                "H.264",
                MFT_CATEGORY_VIDEO_ENCODER,
                MFMediaType_Video,
                MFVideoFormat_H264,
            ),
            (
                "HEVC",
                MFT_CATEGORY_VIDEO_ENCODER,
                MFMediaType_Video,
                MFVideoFormat_HEVC,
            ),
            (
                "AAC",
                MFT_CATEGORY_AUDIO_ENCODER,
                MFMediaType_Audio,
                MFAudioFormat_AAC,
            ),
        ] {
            match super::encoders(category, major, subtype) {
                Ok(encoders) => eprintln!("{name} encoders: {encoders:?}"),
                Err(error) => eprintln!("{name} encoders: none, {error}"),
            }
        }
    }
}
