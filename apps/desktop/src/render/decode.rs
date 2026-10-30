// A source's pictures, decoded by AVFoundation (in hardware, where there's a
// decoder for the codec) in the order the export asks for them.

use std::path::Path;

use objc2::rc::Retained;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetTrack, AVMediaTypeVideo,
    AVURLAsset,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMTimeRange, kCMTimePositiveInfinity};
use objc2_core_video::{
    CVPixelBuffer, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use serde::Serialize;

use super::av::{any, av, bridged, describe, dictionary, file_url, seconds, to_seconds};

/// A source's picture as the editor shows it: turned as the file says.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    /// Clockwise, in degrees: 0, 90, 180 or 270.
    pub rotation: u32,
}

// The tolerance between a time asked for and a frame's: far under a frame.
const EPSILON: f64 = 1e-4;

// How far ahead decoding on is quicker than seeking.
const SEEK_AHEAD: f64 = 2.0;

// Reading starts at least this long before a source's end, so as to find its
// last frame, which starts before the end by its own duration.
const LAST_SEEK: f64 = 1.0;

/// What a source is, if AVFoundation can decode its pictures.
pub fn probe(location: &Path) -> Result<Option<SourceInfo>, String> {
    let asset = open_asset(location)?;
    let Some(track) = video_track(&asset)? else {
        return Ok(None);
    };
    // The synchronous properties: on the export's thread, waiting is fine.
    #[allow(deprecated)]
    let (decodable, size, transform) = unsafe {
        (
            track.isDecodable(),
            track.naturalSize(),
            track.preferredTransform(),
        )
    };
    if !decodable {
        return Ok(None);
    }
    let degrees = transform.b.atan2(transform.a).to_degrees();
    let rotation = ((degrees / 90.0).round() as i32).rem_euclid(4) as u32 * 90;
    let (width, height) = (size.width.round() as u32, size.height.round() as u32);
    let (width, height) = if rotation.is_multiple_of(180) {
        (width, height)
    } else {
        (height, width)
    };
    Ok(Some(SourceInfo {
        width,
        height,
        rotation,
    }))
}

pub(super) fn open_asset(location: &Path) -> Result<Retained<AVURLAsset>, String> {
    let url = file_url(location)?;
    Ok(unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) })
}

fn video_track(asset: &AVURLAsset) -> Result<Option<Retained<AVAssetTrack>>, String> {
    #[allow(deprecated)]
    let tracks = unsafe { asset.tracksWithMediaType(av!(AVMediaTypeVideo)) };
    Ok(tracks.firstObject())
}

struct Frame {
    time: f64,
    pixels: CFRetained<CVPixelBuffer>,
}

/// A source's frames from a time on: the one showing at each time asked,
/// each later than the last, or a seek.
pub struct VideoReader {
    asset: Retained<AVURLAsset>,
    track: Retained<AVAssetTrack>,
    reader: Retained<AVAssetReader>,
    output: Retained<AVAssetReaderTrackOutput>,
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
        let asset = open_asset(location)?;
        let track = video_track(&asset)?.ok_or("the file has no pictures")?;
        #[allow(deprecated)]
        let range = unsafe { track.timeRange() };
        let latest_start = to_seconds(range.start) + to_seconds(range.duration) - LAST_SEEK;
        let time = time.min(latest_start);
        let (reader, output) = start_reading(&asset, &track, time)?;
        Ok(Self {
            asset,
            track,
            reader,
            output,
            start: time,
            current: None,
            next: None,
            is_done: false,
            latest_start,
        })
    }

    /// The frame showing at `time`: the last one to start by then, or the
    /// first if none has. None if the source has no frames at all.
    pub fn frame_at(&mut self, time: f64) -> Result<Option<(f64, &CVPixelBuffer)>, String> {
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
            .map(|frame| (frame.time, &*frame.pixels)))
    }

    fn seek(&mut self, time: f64) -> Result<(), String> {
        // Past the end, from before the last frame, to show it.
        let time = time.min(self.latest_start);
        unsafe { self.reader.cancelReading() };
        let (reader, output) = start_reading(&self.asset, &self.track, time)?;
        self.reader = reader;
        self.output = output;
        self.start = time;
        self.current = None;
        self.next = None;
        self.is_done = false;
        Ok(())
    }

    fn read(&mut self) -> Result<Option<Frame>, String> {
        while !self.is_done {
            let Some(sample) = (unsafe { self.output.copyNextSampleBuffer() }) else {
                self.is_done = true;
                if unsafe { self.reader.status() } == AVAssetReaderStatus::Failed {
                    let error = unsafe { self.reader.error() };
                    return Err(describe(error, "Couldn't decode a source"));
                }
                break;
            };
            // Samples without a picture (markers) are skipped.
            let Some(pixels) = (unsafe { sample.image_buffer() }) else {
                continue;
            };
            let time = to_seconds(unsafe { sample.presentation_time_stamp() });
            return Ok(Some(Frame { time, pixels }));
        }
        Ok(None)
    }
}

impl Drop for VideoReader {
    fn drop(&mut self) {
        unsafe { self.reader.cancelReading() };
    }
}

fn start_reading(
    asset: &AVURLAsset,
    track: &AVAssetTrack,
    time: f64,
) -> Result<(Retained<AVAssetReader>, Retained<AVAssetReaderTrackOutput>), String> {
    let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(asset) }
        .map_err(|error| describe(Some(error), "Couldn't read a source"))?;
    // BGRA, the compositor's own order, in memory the GPU can read.
    let format = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
    let yes = NSNumber::new_bool(true);
    let surface = NSDictionary::<NSString>::new();
    let settings = unsafe {
        dictionary(&[
            (bridged(kCVPixelBufferPixelFormatTypeKey), any(&format)),
            (bridged(kCVPixelBufferMetalCompatibilityKey), any(&yes)),
            (bridged(kCVPixelBufferIOSurfacePropertiesKey), any(&surface)),
        ])
    };
    let output = unsafe {
        AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(
            track,
            Some(&settings),
        )
    };
    unsafe {
        // The decoder's own buffers, not copies.
        output.setAlwaysCopiesSampleData(false);
        reader.addOutput(&output);
        reader.setTimeRange(CMTimeRange {
            start: seconds(time.max(0.0)),
            duration: kCMTimePositiveInfinity,
        });
    }
    if !unsafe { reader.startReading() } {
        let error = unsafe { reader.error() };
        return Err(describe(error, "Couldn't read a source"));
    }
    Ok((reader, output))
}
