// The film, encoded and written by AVFoundation: its encoders (in hardware
// for H.264, HEVC and ProRes on the Macs that have them) and its muxer, for
// MP4 and QuickTime files.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::ptr::{self, NonNull};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetWriter,
    AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus, AVFileTypeMPEG4,
    AVFileTypeQuickTimeMovie, AVMediaTypeAudio, AVMediaTypeVideo, AVVideoAverageBitRateKey,
    AVVideoCodecKey, AVVideoCodecTypeAppleProRes422, AVVideoCodecTypeAppleProRes422HQ,
    AVVideoCodecTypeH264, AVVideoCodecTypeHEVC, AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoColorPrimariesKey, AVVideoColorPropertiesKey, AVVideoCompressionPropertiesKey,
    AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalDurationKey,
    AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey, AVVideoQualityKey,
    AVVideoTransferFunction_ITU_R_709_2, AVVideoTransferFunctionKey, AVVideoWidthKey,
    AVVideoYCbCrMatrix_ITU_R_709_2, AVVideoYCbCrMatrixKey,
};
use objc2_avf_audio::{AVEncoderBitRateKey, AVFormatIDKey, AVNumberOfChannelsKey, AVSampleRateKey};
use objc2_core_audio_types::{
    AudioStreamBasicDescription, kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked,
    kAudioFormatLinearPCM, kAudioFormatMPEG4AAC,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionCreate, CMAudioSampleBufferCreateReadyWithPacketDescriptions,
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMTime, CMTimeRange,
    kCMBlockBufferAssureMemoryNowFlag, kCMTimeZero,
};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferPool, kCVPixelBufferHeightKey,
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA,
    kCVReturnSuccess,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use serde::Deserialize;

use super::av::{
    any, av, bridged, cf_dictionary, describe, dictionary, file_url, fraction, seconds,
};
use super::av1::Av1Encoder;
use super::decode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mov,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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
    /// Constant quality instead of a bitrate, from 0 to 1: H.264 and HEVC
    /// on Apple silicon (`constant_quality`).
    pub quality: Option<f32>,
    pub fps: FrameRate,
}

/// Whether this Mac's H.264 and HEVC encoders take a constant quality: the
/// hardware ones on Apple silicon do; on Intel the setting would be ignored.
pub fn constant_quality() -> bool {
    cfg!(target_arch = "aarch64")
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

// A sound sample buffer's length, in seconds: short, so the sound and the
// pictures interleave closely.
const AUDIO_CHUNK: f64 = 0.1;

// How long an encoder may take no data before the export is given up.
const STALL: Duration = Duration::from_secs(30);

// The longest a key frame is from the last: a seek within the file decodes
// no more than this.
const KEY_FRAME_INTERVAL: f64 = 2.0;

struct AudioInput {
    input: Retained<AVAssetWriterInput>,
    source: AudioSource,
    /// Whether the input's been told the sound is over.
    is_finished: bool,
}

enum AudioSource {
    Mix(Mix),
    Copy(Copy),
}

/// The editor's mix, in buffers for the encoder.
struct Mix {
    /// The mix's samples: float, interleaved.
    format: CFRetained<CMFormatDescription>,
    channels: u32,
    sample_rate: u32,
    queued: VecDeque<CFRetained<CMSampleBuffer>>,
    /// Sample frames queued so far: where the next buffer starts.
    frames: i64,
    /// Whether the mix has all been queued.
    is_complete: bool,
}

/// A file's sound, read as it's stored.
struct Copy {
    reader: Retained<AVAssetReader>,
    output: Retained<AVAssetReaderTrackOutput>,
    /// Read before the writer started, for its format.
    first: Option<CFRetained<CMSampleBuffer>>,
    is_done: bool,
}

/// Where the frames go: to AVFoundation's encoder, through its pixel buffer
/// adaptor, or to rav1e, whose packets the writer passes through.
enum VideoSink {
    Adaptor(Retained<AVAssetWriterInputPixelBufferAdaptor>),
    Av1 {
        encoder: Box<Av1Encoder>,
        /// The buffers frames are drawn into.
        pool: CFRetained<CVPixelBufferPool>,
    },
}

pub struct Writer {
    writer: Retained<AVAssetWriter>,
    video: Retained<AVAssetWriterInput>,
    sink: VideoSink,
    audio: Option<AudioInput>,
    fps: FrameRate,
    frames: i64,
}

impl Writer {
    /// Starts a file at `path`, replacing what's there.
    pub fn new(
        path: &Path,
        container: Container,
        video: &VideoSettings,
        audio: Option<Audio>,
    ) -> Result<Self, String> {
        if container == Container::Mp4
            && matches!(video.codec, VideoCodec::ProRes | VideoCodec::ProResHq)
        {
            return Err("ProRes goes in a QuickTime file".into());
        }
        if container == Container::Mov && video.codec == VideoCodec::Av1 {
            return Err("AV1 goes in an MP4 file".into());
        }
        // AVAssetWriter won't write over a file.
        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string());
            }
            _ => {}
        }
        let file_type = match container {
            Container::Mp4 => av!(AVFileTypeMPEG4),
            Container::Mov => av!(AVFileTypeQuickTimeMovie),
        };
        let url = file_url(path)?;
        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }
            .map_err(|error| describe(Some(error), "Couldn't start the file"))?;
        // The index at the start, so the film plays as it downloads.
        unsafe { writer.setShouldOptimizeForNetworkUse(container == Container::Mp4) };

        let format = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
        let width = NSNumber::new_u32(video.width);
        let height = NSNumber::new_u32(video.height);
        let yes = NSNumber::new_bool(true);
        let surface = NSDictionary::<NSString>::new();
        let attributes = unsafe {
            dictionary(&[
                (bridged(kCVPixelBufferPixelFormatTypeKey), any(&format)),
                (bridged(kCVPixelBufferWidthKey), any(&width)),
                (bridged(kCVPixelBufferHeightKey), any(&height)),
                (bridged(kCVPixelBufferMetalCompatibilityKey), any(&yes)),
                (bridged(kCVPixelBufferIOSurfacePropertiesKey), any(&surface)),
            ])
        };
        let (video_input, sink) = if video.codec == VideoCodec::Av1 {
            let encoder = Av1Encoder::new(
                (video.width, video.height),
                video.fps,
                video.bitrate,
                video.quality,
                KEY_FRAME_INTERVAL,
            )?;
            // No settings: the packets as they are, in the format given.
            let input = unsafe {
                AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings_sourceFormatHint(
                    av!(AVMediaTypeVideo),
                    None,
                    Some(encoder.format()),
                )
            };
            let mut pool: *mut CVPixelBufferPool = ptr::null_mut();
            let status = unsafe {
                CVPixelBufferPool::create(
                    None,
                    None,
                    Some(cf_dictionary(&attributes)),
                    NonNull::from(&mut pool),
                )
            };
            let pool = NonNull::new(pool)
                .filter(|_| status == kCVReturnSuccess)
                .ok_or("Couldn't make buffers for the frames")?;
            // SAFETY: created, so ours to release.
            let pool = unsafe { CFRetained::from_raw(pool) };
            (
                input,
                VideoSink::Av1 {
                    encoder: Box::new(encoder),
                    pool,
                },
            )
        } else {
            let settings = video_output_settings(video)?;
            // An input raises an exception for settings it won't take.
            if !unsafe {
                writer.canApplyOutputSettings_forMediaType(Some(&settings), av!(AVMediaTypeVideo))
            } {
                return Err(format!(
                    "This Mac can't encode {:?} at {}x{}",
                    video.codec, video.width, video.height
                ));
            }
            let input = unsafe {
                AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
                    av!(AVMediaTypeVideo),
                    Some(&settings),
                )
            };
            let adaptor = unsafe {
                AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(
                    &input,
                    Some(&attributes),
                )
            };
            (input, VideoSink::Adaptor(adaptor))
        };
        unsafe { video_input.setExpectsMediaDataInRealTime(false) };
        add_input(&writer, &video_input)?;

        let audio = match audio {
            Some(Audio::Mix(settings)) => Some(AudioInput::mixing(&writer, settings)?),
            Some(Audio::Copy { location, end }) => {
                Some(AudioInput::copying(&writer, &location, end)?)
            }
            None => None,
        };

        if !unsafe { writer.startWriting() } {
            return Err(describe(
                unsafe { writer.error() },
                "Couldn't start the file",
            ));
        }
        unsafe { writer.startSessionAtSourceTime(kCMTimeZero) };
        Ok(Self {
            writer,
            video: video_input,
            sink,
            audio,
            fps: video.fps,
            frames: 0,
        })
    }

    /// A buffer for the next frame, from the encoder's own pool.
    pub fn pixel_buffer(&self) -> Result<CFRetained<CVPixelBuffer>, String> {
        let adaptor_pool: Retained<CVPixelBufferPool>;
        let pool: &CVPixelBufferPool = match &self.sink {
            VideoSink::Adaptor(adaptor) => {
                adaptor_pool = unsafe { adaptor.pixelBufferPool() }
                    .ok_or_else(|| self.failure("The encoder has no buffers"))?;
                &adaptor_pool
            }
            VideoSink::Av1 { pool, .. } => pool,
        };
        let mut buffer: *mut CVPixelBuffer = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer(None, pool, NonNull::from(&mut buffer))
        };
        let buffer = NonNull::new(buffer)
            .filter(|_| status == kCVReturnSuccess)
            .ok_or("Couldn't get a buffer for a frame")?;
        // SAFETY: created, so ours to release.
        Ok(unsafe { CFRetained::from_raw(buffer) })
    }

    /// Adds the next frame, once the encoder takes more.
    pub fn add_frame(&mut self, buffer: &CVPixelBuffer) -> Result<(), String> {
        match &mut self.sink {
            VideoSink::Adaptor(_) => {
                self.wait_for_video()?;
                let time = fraction(
                    self.frames * i64::from(self.fps.denominator),
                    self.fps.numerator as i32,
                );
                let VideoSink::Adaptor(adaptor) = &self.sink else {
                    unreachable!();
                };
                if !unsafe { adaptor.appendPixelBuffer_withPresentationTime(buffer, time) } {
                    return Err(self.failure("Couldn't encode a frame"));
                }
            }
            VideoSink::Av1 { encoder, .. } => {
                encoder.send(buffer)?;
                self.write_packets()?;
            }
        }
        self.frames += 1;
        Ok(())
    }

    /// Passes the packets rav1e has made into the file.
    fn write_packets(&mut self) -> Result<(), String> {
        loop {
            let VideoSink::Av1 { encoder, .. } = &mut self.sink else {
                return Ok(());
            };
            let Some(sample) = encoder.receive()? else {
                return Ok(());
            };
            self.wait_for_video()?;
            if !unsafe { self.video.appendSampleBuffer(&sample) } {
                return Err(self.failure("Couldn't write a frame"));
            }
        }
    }

    /// Adds the mix's next samples: float, interleaved. The encoder's told
    /// when they're the last: it holds back the end of the sound until then,
    /// and the frames with it, to keep the two interleaved.
    pub fn add_audio(&mut self, samples: &[f32], is_last: bool) -> Result<(), String> {
        let Some(AudioInput {
            source: AudioSource::Mix(mix),
            ..
        }) = &mut self.audio
        else {
            return Err("the export takes no mix".into());
        };
        if mix.is_complete {
            return Err("the sound has already ended".into());
        }
        mix.queue(samples)?;
        mix.is_complete = is_last;
        self.drain_audio()
    }

    /// Ends the film where its last frame does, and finishes the file.
    pub fn finish(mut self) -> Result<(), String> {
        if let VideoSink::Av1 { encoder, .. } = &mut self.sink {
            encoder.flush();
            self.write_packets()?;
        }
        unsafe { self.video.markAsFinished() };
        let started = Instant::now();
        while self
            .audio
            .as_ref()
            .is_some_and(|audio| !audio.source.is_exhausted())
        {
            self.drain_audio()?;
            self.check(started)?;
            thread::sleep(Duration::from_millis(1));
        }
        if let Some(audio) = &mut self.audio {
            audio.finish();
        }
        let end = fraction(
            self.frames * i64::from(self.fps.denominator),
            self.fps.numerator as i32,
        );
        unsafe { self.writer.endSessionAtSourceTime(end) };
        let (sender, receiver) = mpsc::channel();
        let done = RcBlock::new(move || {
            let _ = sender.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        receiver.recv().map_err(|error| error.to_string())?;
        if unsafe { self.writer.status() } != AVAssetWriterStatus::Completed {
            return Err(self.failure("Couldn't finish the file"));
        }
        Ok(())
    }

    /// Stops, leaving the file unfinished: the caller deletes it.
    pub fn cancel(self) {
        if unsafe { self.writer.status() } == AVAssetWriterStatus::Writing {
            unsafe { self.writer.cancelWriting() };
        }
    }

    /// Waits for the encoder to take another frame, giving it sound
    /// meanwhile: it waits for both to keep them interleaved.
    fn wait_for_video(&mut self) -> Result<(), String> {
        let started = Instant::now();
        loop {
            self.drain_audio()?;
            if unsafe { self.video.isReadyForMoreMediaData() } {
                return Ok(());
            }
            self.check(started)?;
            thread::sleep(Duration::from_micros(250));
        }
    }

    /// Hands over the sound there is, as much as the encoder takes now.
    fn drain_audio(&mut self) -> Result<(), String> {
        let Some(audio) = &mut self.audio else {
            return Ok(());
        };
        if audio.is_finished {
            return Ok(());
        }
        while unsafe { audio.input.isReadyForMoreMediaData() } {
            let Some(buffer) = audio.source.next()? else {
                break;
            };
            if !unsafe { audio.input.appendSampleBuffer(&buffer) } {
                let error = unsafe { self.writer.error() };
                return Err(describe(error, "Couldn't write the sound"));
            }
        }
        if audio.source.is_exhausted() {
            audio.finish();
        }
        Ok(())
    }

    fn check(&self, started: Instant) -> Result<(), String> {
        if unsafe { self.writer.status() } == AVAssetWriterStatus::Failed {
            return Err(self.failure("The encoder stopped"));
        }
        if started.elapsed() > STALL {
            return Err("The encoder stopped taking frames".into());
        }
        Ok(())
    }

    fn failure(&self, doing: &str) -> String {
        describe(unsafe { self.writer.error() }, doing)
    }
}

fn add_input(writer: &AVAssetWriter, input: &AVAssetWriterInput) -> Result<(), String> {
    if !unsafe { writer.canAddInput(input) } {
        return Err("The file can't take these settings".into());
    }
    unsafe { writer.addInput(input) };
    Ok(())
}

fn video_output_settings(
    video: &VideoSettings,
) -> Result<Retained<NSDictionary<NSString, objc2::runtime::AnyObject>>, String> {
    let codec = match video.codec {
        VideoCodec::Avc => av!(AVVideoCodecTypeH264),
        VideoCodec::Hevc => av!(AVVideoCodecTypeHEVC),
        VideoCodec::ProRes => av!(AVVideoCodecTypeAppleProRes422),
        VideoCodec::ProResHq => av!(AVVideoCodecTypeAppleProRes422HQ),
        VideoCodec::Av1 => return Err("AV1 is encoded by rav1e, not AVFoundation".into()),
    };
    // HD's colours, which the editor's pictures are in.
    let colors = dictionary(&[
        (
            av!(AVVideoColorPrimariesKey),
            any(av!(AVVideoColorPrimaries_ITU_R_709_2)),
        ),
        (
            av!(AVVideoTransferFunctionKey),
            any(av!(AVVideoTransferFunction_ITU_R_709_2)),
        ),
        (
            av!(AVVideoYCbCrMatrixKey),
            any(av!(AVVideoYCbCrMatrix_ITU_R_709_2)),
        ),
    ]);
    let bitrate = NSNumber::new_u32(video.bitrate);
    let quality = video
        .quality
        .map(|quality| NSNumber::new_f32(quality.clamp(0.0, 1.0)));
    let fps = NSNumber::new_f64(f64::from(video.fps.numerator) / f64::from(video.fps.denominator));
    let key_frames = NSNumber::new_f64(KEY_FRAME_INTERVAL);
    // HEVC's Main profile (VideoToolbox's kVTProfileLevel_HEVC_Main_AutoLevel).
    let hevc_main = NSString::from_str("HEVC_Main_AutoLevel");
    let rate = match &quality {
        Some(quality) => (av!(AVVideoQualityKey), any(quality)),
        None => (av!(AVVideoAverageBitRateKey), any(&bitrate)),
    };
    let mut compression = vec![
        rate,
        (av!(AVVideoExpectedSourceFrameRateKey), any(&fps)),
        (av!(AVVideoMaxKeyFrameIntervalDurationKey), any(&key_frames)),
    ];
    match video.codec {
        VideoCodec::Avc => compression.push((
            av!(AVVideoProfileLevelKey),
            any(av!(AVVideoProfileLevelH264HighAutoLevel)),
        )),
        VideoCodec::Hevc => compression.push((av!(AVVideoProfileLevelKey), any(&hevc_main))),
        // ProRes takes no compression settings: its rate is the codec's.
        VideoCodec::ProRes | VideoCodec::ProResHq | VideoCodec::Av1 => compression.clear(),
    }
    let compression = dictionary(&compression);
    let width = NSNumber::new_u32(video.width);
    let height = NSNumber::new_u32(video.height);
    let mut settings = vec![
        (av!(AVVideoCodecKey), any(codec)),
        (av!(AVVideoWidthKey), any(&width)),
        (av!(AVVideoHeightKey), any(&height)),
        (av!(AVVideoColorPropertiesKey), any(&colors)),
    ];
    if compression.count() > 0 {
        settings.push((av!(AVVideoCompressionPropertiesKey), any(&compression)));
    }
    Ok(dictionary(&settings))
}

impl AudioInput {
    fn mixing(writer: &AVAssetWriter, settings: AudioSettings) -> Result<Self, String> {
        let aac = NSNumber::new_u32(kAudioFormatMPEG4AAC);
        let rate = NSNumber::new_f64(f64::from(settings.sample_rate));
        let channels = NSNumber::new_u32(settings.channels);
        let bitrate = NSNumber::new_u32(settings.bitrate);
        let output = dictionary(&[
            (av!(AVFormatIDKey), any(&aac)),
            (av!(AVSampleRateKey), any(&rate)),
            (av!(AVNumberOfChannelsKey), any(&channels)),
            (av!(AVEncoderBitRateKey), any(&bitrate)),
        ]);
        if !unsafe {
            writer.canApplyOutputSettings_forMediaType(Some(&output), av!(AVMediaTypeAudio))
        } {
            return Err(format!(
                "This Mac can't encode AAC at {} Hz in {} channels and {} bit/s",
                settings.sample_rate, settings.channels, settings.bitrate
            ));
        }
        let input = unsafe {
            AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
                av!(AVMediaTypeAudio),
                Some(&output),
            )
        };
        unsafe { input.setExpectsMediaDataInRealTime(false) };
        add_input(writer, &input)?;
        let mix = Mix {
            format: pcm_format(settings.channels, settings.sample_rate)?,
            channels: settings.channels,
            sample_rate: settings.sample_rate,
            queued: VecDeque::new(),
            frames: 0,
            is_complete: false,
        };
        Ok(Self {
            input,
            source: AudioSource::Mix(mix),
            is_finished: false,
        })
    }

    /// Copies the sound of the file at `location` up to `end` seconds, as
    /// it's stored: the writer passes it through in its own format.
    fn copying(writer: &AVAssetWriter, location: &Path, end: f64) -> Result<Self, String> {
        let asset = decode::open_asset(location)?;
        #[allow(deprecated)]
        let track = unsafe { asset.tracksWithMediaType(av!(AVMediaTypeAudio)) }
            .firstObject()
            .ok_or("The file has no sound to copy")?;
        let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&asset) }
            .map_err(|error| describe(Some(error), "Couldn't read the sound"))?;
        // No settings: the samples as they're stored.
        let output = unsafe {
            AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(&track, None)
        };
        unsafe {
            reader.addOutput(&output);
            reader.setTimeRange(CMTimeRange {
                start: kCMTimeZero,
                duration: seconds(end),
            });
        }
        if !unsafe { reader.startReading() } {
            return Err(describe(
                unsafe { reader.error() },
                "Couldn't read the sound",
            ));
        }
        let first = unsafe { output.copyNextSampleBuffer() }.ok_or("The file's sound is empty")?;
        let format =
            unsafe { first.format_description() }.ok_or("The file's sound has no format")?;
        // A file other than QuickTime takes copied sound only with its format.
        let input = unsafe {
            AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings_sourceFormatHint(
                av!(AVMediaTypeAudio),
                None,
                Some(&format),
            )
        };
        unsafe { input.setExpectsMediaDataInRealTime(false) };
        add_input(writer, &input)?;
        let copy = Copy {
            reader,
            output,
            first: Some(first.into()),
            is_done: false,
        };
        Ok(Self {
            input,
            source: AudioSource::Copy(copy),
            is_finished: false,
        })
    }

    fn finish(&mut self) {
        if !self.is_finished {
            unsafe { self.input.markAsFinished() };
            self.is_finished = true;
        }
    }
}

impl AudioSource {
    /// The next buffer to hand over, if there's one yet.
    fn next(&mut self) -> Result<Option<CFRetained<CMSampleBuffer>>, String> {
        match self {
            Self::Mix(mix) => Ok(mix.queued.pop_front()),
            Self::Copy(copy) => copy.next(),
        }
    }

    /// Whether all the sound has been handed over.
    fn is_exhausted(&self) -> bool {
        match self {
            Self::Mix(mix) => mix.is_complete && mix.queued.is_empty(),
            Self::Copy(copy) => copy.is_done,
        }
    }
}

impl Copy {
    fn next(&mut self) -> Result<Option<CFRetained<CMSampleBuffer>>, String> {
        if let Some(first) = self.first.take() {
            return Ok(Some(first));
        }
        if self.is_done {
            return Ok(None);
        }
        let sample = unsafe { self.output.copyNextSampleBuffer() };
        if sample.is_none() {
            self.is_done = true;
            if unsafe { self.reader.status() } == AVAssetReaderStatus::Failed {
                return Err(describe(
                    unsafe { self.reader.error() },
                    "Couldn't read the sound",
                ));
            }
        }
        Ok(sample.map(CFRetained::from))
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        unsafe { self.reader.cancelReading() };
    }
}

impl Mix {
    fn queue(&mut self, samples: &[f32]) -> Result<(), String> {
        let channels = self.channels as usize;
        let chunk_frames = (f64::from(self.sample_rate) * AUDIO_CHUNK) as usize;
        for chunk in samples.chunks(chunk_frames * channels) {
            let frames = chunk.len() / channels;
            if frames == 0 {
                continue;
            }
            let start = fraction(self.frames, self.sample_rate as i32);
            let buffer =
                pcm_sample_buffer(&self.format, &chunk[..frames * channels], frames, start)?;
            self.queued.push_back(buffer);
            self.frames += frames as i64;
        }
        Ok(())
    }
}

/// The mix's format: 32-bit float, interleaved.
fn pcm_format(channels: u32, sample_rate: u32) -> Result<CFRetained<CMFormatDescription>, String> {
    let description = AudioStreamBasicDescription {
        mSampleRate: f64::from(sample_rate),
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4 * channels,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4 * channels,
        mChannelsPerFrame: channels,
        mBitsPerChannel: 32,
        mReserved: 0,
    };
    let mut format: *const CMFormatDescription = ptr::null();
    let status = unsafe {
        CMAudioFormatDescriptionCreate(
            None,
            NonNull::from(&description),
            0,
            ptr::null(),
            0,
            ptr::null(),
            None,
            NonNull::from(&mut format),
        )
    };
    let format = NonNull::new(format.cast_mut())
        .filter(|_| status == 0)
        .ok_or("Couldn't describe the sound")?;
    // SAFETY: created, so ours to release.
    Ok(unsafe { CFRetained::from_raw(format) })
}

/// Samples as a buffer the encoder takes, starting at `start`.
fn pcm_sample_buffer(
    format: &CMFormatDescription,
    samples: &[f32],
    frames: usize,
    start: CMTime,
) -> Result<CFRetained<CMSampleBuffer>, String> {
    let length = std::mem::size_of_val(samples);
    let mut block: *mut CMBlockBuffer = ptr::null_mut();
    let status = unsafe {
        CMBlockBuffer::create_with_memory_block(
            None,
            ptr::null_mut(),
            length,
            None,
            ptr::null(),
            0,
            length,
            kCMBlockBufferAssureMemoryNowFlag,
            NonNull::from(&mut block),
        )
    };
    let block = NonNull::new(block)
        .filter(|_| status == 0)
        .ok_or("Couldn't hold the sound")?;
    // SAFETY: created, so ours to release.
    let block = unsafe { CFRetained::from_raw(block) };
    let status = unsafe {
        CMBlockBuffer::replace_data_bytes(NonNull::from(samples).cast(), &block, 0, length)
    };
    if status != 0 {
        return Err("Couldn't hold the sound".into());
    }
    let mut buffer: *mut CMSampleBuffer = ptr::null_mut();
    let status = unsafe {
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            None,
            &block,
            format,
            frames as isize,
            start,
            ptr::null(),
            NonNull::from(&mut buffer),
        )
    };
    let buffer = NonNull::new(buffer)
        .filter(|_| status == 0)
        .ok_or("Couldn't hold the sound")?;
    // SAFETY: created, so ours to release.
    Ok(unsafe { CFRetained::from_raw(buffer) })
}
