// The native export end to end, on this Mac's AVFoundation and GPU: a film
// made here, decoded, then drawn into another.

use std::path::{Path, PathBuf};

use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};

use super::decode::{self, SourceInfo, VideoReader};
use super::encode::{
    Audio, AudioSettings, Container, FrameRate, VideoCodec, VideoSettings, Writer,
};
use super::frames::Crop;
use super::{Message, StartOptions, VideoFrame, Worker};

const FPS: FrameRate = FrameRate {
    numerator: 30,
    denominator: 1,
};

fn temporary(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("magnetcut-render-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    directory.join(name)
}

/// Frame `i`'s grey: a level apart from each other frame's.
fn grey(i: usize) -> u8 {
    (i * 8) as u8
}

/// Every pixel's BGRA bytes, by row.
fn with_pixels<T>(buffer: &CVPixelBuffer, read: impl FnOnce(&mut [u8], usize) -> T) -> T {
    let lock = CVPixelBufferLockFlags(0);
    unsafe { CVPixelBufferLockBaseAddress(buffer, lock) };
    let row = CVPixelBufferGetBytesPerRow(buffer);
    let length = row * CVPixelBufferGetHeight(buffer);
    let base = CVPixelBufferGetBaseAddress(buffer).cast::<u8>();
    let result = read(unsafe { std::slice::from_raw_parts_mut(base, length) }, row);
    unsafe { CVPixelBufferUnlockBaseAddress(buffer, lock) };
    result
}

/// The middle pixel's blue, green and red.
fn middle(buffer: &CVPixelBuffer) -> [u8; 3] {
    let (width, height) = (
        CVPixelBufferGetWidth(buffer),
        CVPixelBufferGetHeight(buffer),
    );
    with_pixels(buffer, |pixels, row| {
        let at = (height / 2) * row + (width / 2) * 4;
        [pixels[at], pixels[at + 1], pixels[at + 2]]
    })
}

fn assert_grey(color: [u8; 3], level: u8) {
    for channel in color {
        assert!(
            channel.abs_diff(level) <= 6,
            "{color:?} isn't the grey {level}"
        );
    }
}

/// A second of 64×64 frames, each its own grey.
fn make_source(path: &Path) {
    let video = VideoSettings {
        codec: VideoCodec::Avc,
        width: 64,
        height: 64,
        bitrate: 2_000_000,
        quality: None,
        fps: FPS,
    };
    let mut writer = Writer::new(path, Container::Mp4, &video, None).unwrap();
    for i in 0..30 {
        let buffer = writer.pixel_buffer().unwrap();
        with_pixels(&buffer, |pixels, _| {
            for pixel in pixels.as_chunks_mut::<4>().0 {
                *pixel = [grey(i), grey(i), grey(i), 255];
            }
        });
        writer.add_frame(&buffer).unwrap();
    }
    writer.finish().unwrap();
}

#[test]
fn decodes_the_frames_it_encoded() {
    let path = temporary("source.mp4");
    make_source(&path);
    assert_eq!(
        decode::probe(&path).unwrap(),
        Some(SourceInfo {
            width: 64,
            height: 64,
            rotation: 0
        })
    );

    let mut reader = VideoReader::open(&path, 0.0).unwrap();
    let (time, pixels) = reader.frame_at(0.5).unwrap().unwrap();
    assert!((time - 0.5).abs() < 1e-3, "{time}");
    assert_grey(middle(pixels), grey(15));
    // Between two frames, the one showing.
    let (time, _) = reader.frame_at(0.52).unwrap().unwrap();
    assert!((time - 0.5).abs() < 1e-3, "{time}");
    // Back, a seek.
    let (time, pixels) = reader.frame_at(0.1).unwrap().unwrap();
    assert!((time - 0.1).abs() < 1e-3, "{time}");
    assert_grey(middle(pixels), grey(3));
    // Past the end, the last frame.
    let (time, _) = reader.frame_at(5.0).unwrap().unwrap();
    assert!((time - 29.0 / 30.0).abs() < 1e-3, "{time}");

    // Opened late, the frame showing then.
    let mut reader = VideoReader::open(&path, 0.7).unwrap();
    let (time, _) = reader.frame_at(0.7).unwrap().unwrap();
    assert!((time - 0.7).abs() < 1e-3, "{time}");
}

/// A layer showing the texture `id` over the whole of a `size` canvas.
fn frame_showing(id: &str, size: u32) -> compositor::FrameDescriptor {
    frame_sized(id, size, size)
}

/// A layer showing the texture `id` over the whole of a canvas this size.
fn frame_sized(id: &str, width: u32, height: u32) -> compositor::FrameDescriptor {
    let (center_x, center_y) = (width as f32 / 2.0, height as f32 / 2.0);
    serde_json::from_value(serde_json::json!({
        "width": width,
        "height": height,
        "clear": { "color": [0, 0, 0, 1] },
        "items": [{
            "type": "layer",
            "textureId": id,
            "transform": {
                "centerX": center_x, "centerY": center_y, "width": width, "height": height,
                "rotationDegrees": 0, "flipX": false, "flipY": false
            },
            "opacity": 1,
            "blendMode": "normal",
            "effectPassGroups": [],
            "mask": null
        }]
    }))
    .unwrap()
}

#[test]
fn draws_a_source_into_a_film_cut_and_scaled() {
    let source = temporary("drawn-source.mp4");
    make_source(&source);
    let path = temporary("drawn.mov");
    // A 128-pixel project, a quarter cut from the left, scaled to 48×64.
    let options = StartOptions {
        path: path.to_str().unwrap().to_owned(),
        format: Container::Mov,
        width: 128,
        height: 128,
        crop: Crop {
            left: 32,
            ..Crop::default()
        },
        output_width: 48,
        output_height: 64,
        fps: FPS,
        video_codec: VideoCodec::Hevc,
        video_bitrate: 1_000_000,
        video_quality: None,
        audio: Some(AudioSettings {
            channels: 2,
            sample_rate: 44_100,
            bitrate: 128_000,
        }),
        audio_copy: None,
    };
    let Ok(mut worker) = Worker::new(&path, &options) else {
        eprintln!("No GPU: skipped");
        return;
    };
    // The editor's drawing, under the video: never seen, but uploaded.
    let drawing = Message::Texture {
        id: "drawing".into(),
        width: 2,
        height: 2,
        pixels: vec![255; 16],
    };
    worker.handle(drawing).unwrap();
    // A second of a tone, sent ahead of the frames as the editor does.
    let tone: Vec<f32> = (0..44_100)
        .flat_map(|i| {
            let sample = (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5;
            [sample, sample]
        })
        .collect();
    worker
        .handle(Message::Audio {
            samples: tone,
            is_last: true,
        })
        .unwrap();
    for i in 0..30 {
        let video = VideoFrame {
            texture_id: "video".into(),
            location: source.clone(),
            stream: String::new(),
            time: i as f64 / 30.0,
        };
        let message = Message::Frame {
            frame: frame_showing("video", 128),
            videos: vec![video],
            released: if i == 0 {
                vec!["drawing".into()]
            } else {
                vec![]
            },
        };
        worker.handle(message).unwrap();
    }
    worker.finish().unwrap();

    assert_eq!(
        decode::probe(&path).unwrap(),
        Some(SourceInfo {
            width: 48,
            height: 64,
            rotation: 0
        })
    );
    let mut reader = VideoReader::open(&path, 0.0).unwrap();
    let (_, pixels) = reader.frame_at(0.5).unwrap().unwrap();
    assert_grey(middle(pixels), grey(15));
    let (time, _) = reader.frame_at(5.0).unwrap().unwrap();
    assert!((time - 29.0 / 30.0).abs() < 1e-3, "{time}");
}

#[test]
fn a_cancelled_export_leaves_no_file() {
    let path = temporary("cancelled.mp4");
    let options = StartOptions {
        path: path.to_str().unwrap().to_owned(),
        format: Container::Mp4,
        width: 64,
        height: 64,
        crop: Crop::default(),
        output_width: 64,
        output_height: 64,
        fps: FPS,
        video_codec: VideoCodec::Avc,
        video_bitrate: 1_000_000,
        video_quality: None,
        audio: None,
        audio_copy: None,
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let (ready_sender, ready) = std::sync::mpsc::channel();
    let failure = std::sync::Mutex::new(None);
    let (worker_path, options, failure) = (path.clone(), &options, &failure);
    std::thread::scope(|scope| {
        scope.spawn(move || super::run(&worker_path, options, &receiver, &ready_sender, failure));
        if ready.recv().unwrap().is_err() {
            eprintln!("No GPU: skipped");
            return;
        }
        assert!(path.exists());
        drop(sender);
    });
    assert!(!path.exists());
}

#[test]
fn prores_goes_only_in_a_quicktime_file() {
    let video = VideoSettings {
        codec: VideoCodec::ProRes,
        width: 64,
        height: 64,
        bitrate: 0,
        quality: None,
        fps: FPS,
    };
    assert!(Writer::new(&temporary("prores.mp4"), Container::Mp4, &video, None).is_err());
    let path = temporary("prores.mov");
    let mut writer = Writer::new(&path, Container::Mov, &video, None).unwrap();
    let buffer = writer.pixel_buffer().unwrap();
    writer.add_frame(&buffer).unwrap();
    writer.finish().unwrap();
    assert!(decode::probe(&path).unwrap().is_some());
}

/// Frames hard enough to encode that the encoder interleaves them with the
/// sound by the second, as it does a film's.
fn add_noisy_frames(writer: &mut Writer, frames: std::ops::Range<usize>) -> Result<(), String> {
    for i in frames {
        let buffer = writer.pixel_buffer()?;
        with_pixels(&buffer, |pixels, _| {
            for (j, byte) in pixels.iter_mut().enumerate() {
                *byte = ((j * 7919 + i * 104_729) % 251) as u8;
            }
        });
        writer
            .add_frame(&buffer)
            .map_err(|error| format!("frame {i}: {error}"))?;
    }
    Ok(())
}

fn writer_with_sound(name: &str) -> Writer {
    let video = VideoSettings {
        codec: VideoCodec::Avc,
        width: 320,
        height: 240,
        bitrate: 2_000_000,
        quality: None,
        fps: FPS,
    };
    let audio = AudioSettings {
        channels: 2,
        sample_rate: 44_100,
        bitrate: 128_000,
    };
    Writer::new(
        &temporary(name),
        Container::Mp4,
        &video,
        Some(Audio::Mix(audio)),
    )
    .unwrap()
}

#[test]
fn the_end_of_the_sound_lets_the_last_frames_through() {
    let mut writer = writer_with_sound("ending.mp4");
    writer.add_audio(&vec![0.1; 44_100 * 4 * 2], true).unwrap();
    add_noisy_frames(&mut writer, 0..120).unwrap();
    writer.finish().unwrap();
}

#[test]
fn sound_sent_ahead_keeps_the_frames_going_across_windows() {
    // As the editor sends it (AUDIO_LEAD in native-exporter.ts): 12 s in
    // windows of 10, each once the frames are within 3 s of the sound's end.
    // Sent no sooner, the frames stop short of each window's end.
    let lead = 3.0;
    let mut writer = writer_with_sound("windows.mp4");
    let mut sent = 0.0;
    for i in 0..360 {
        let time = f64::from(i) / 30.0;
        while sent < 12.0 && sent <= time + lead {
            let length = (12.0f64 - sent).min(10.0);
            let samples = vec![0.1; (44_100.0 * length) as usize * 2];
            writer.add_audio(&samples, sent + length >= 12.0).unwrap();
            sent += length;
        }
        add_noisy_frames(&mut writer, i as usize..i as usize + 1).unwrap();
    }
    writer.finish().unwrap();
}

/// A file's sound as it's stored, up to `end` seconds: its packets' sizes,
/// and how long they last.
fn stored_sound(path: &Path, end: f64) -> (Vec<usize>, f64) {
    use objc2_av_foundation::{AVAssetReader, AVAssetReaderTrackOutput, AVMediaTypeAudio};
    use objc2_core_media::{CMTimeRange, kCMTimeZero};

    let asset = decode::open_asset(path).unwrap();
    #[allow(deprecated)]
    let track = unsafe { asset.tracksWithMediaType(AVMediaTypeAudio.unwrap()) }
        .firstObject()
        .expect("no sound");
    let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&asset) }.unwrap();
    let output = unsafe {
        AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(&track, None)
    };
    unsafe {
        reader.addOutput(&output);
        reader.setTimeRange(CMTimeRange {
            start: kCMTimeZero,
            duration: super::av::seconds(end),
        });
        assert!(reader.startReading());
    }
    let (mut sizes, mut last) = (Vec::new(), 0.0);
    while let Some(sample) = unsafe { output.copyNextSampleBuffer() } {
        let count = unsafe { sample.num_samples() } as usize;
        sizes.extend((0..count).map(|i| unsafe { sample.sample_size(i as _) }));
        let start = super::av::to_seconds(unsafe { sample.presentation_time_stamp() });
        last = start + super::av::to_seconds(unsafe { sample.duration() });
    }
    (sizes, last)
}

#[test]
fn copies_a_files_sound_as_it_is() {
    // Two seconds of film and sound, the first second exported with its sound copied.
    let source = temporary("with-sound.mp4");
    let mut writer = Writer::new(
        &source,
        Container::Mp4,
        &VideoSettings {
            codec: VideoCodec::Avc,
            width: 64,
            height: 64,
            bitrate: 1_000_000,
            quality: None,
            fps: FPS,
        },
        Some(Audio::Mix(AudioSettings {
            channels: 2,
            sample_rate: 44_100,
            bitrate: 128_000,
        })),
    )
    .unwrap();
    let tone: Vec<f32> = (0..44_100 * 2)
        .flat_map(|i| {
            let sample = (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5;
            [sample, sample]
        })
        .collect();
    writer.add_audio(&tone, true).unwrap();
    for i in 0..60 {
        let buffer = writer.pixel_buffer().unwrap();
        with_pixels(&buffer, |pixels, _| pixels.fill(grey(i % 30)));
        writer.add_frame(&buffer).unwrap();
    }
    writer.finish().unwrap();

    let path = temporary("copied.mp4");
    let options = StartOptions {
        path: path.to_str().unwrap().to_owned(),
        format: Container::Mp4,
        width: 64,
        height: 64,
        crop: Crop::default(),
        output_width: 64,
        output_height: 64,
        fps: FPS,
        video_codec: VideoCodec::Hevc,
        video_bitrate: 1_000_000,
        video_quality: None,
        audio: None,
        audio_copy: Some(super::AudioCopy {
            path: source.clone(),
            end: 1.0,
        }),
    };
    let Ok(mut worker) = Worker::new(&path, &options) else {
        eprintln!("No GPU: skipped");
        return;
    };
    for i in 0..30 {
        let video = VideoFrame {
            texture_id: "video".into(),
            location: source.clone(),
            stream: String::new(),
            time: f64::from(i) / 30.0,
        };
        let message = Message::Frame {
            frame: frame_showing("video", 64),
            videos: vec![video],
            released: vec![],
        };
        worker.handle(message).unwrap();
    }
    worker.finish().unwrap();

    let (copied, copied_end) = stored_sound(&path, f64::INFINITY);
    let (original, _) = stored_sound(&source, 1.0);
    assert_eq!(copied, original, "the packets aren't the source's");
    assert!((copied_end - 1.0).abs() < 0.05, "{copied_end}");
}

#[test]
fn constant_quality_steers_the_encoder() {
    if !super::encode::constant_quality() {
        eprintln!("No constant quality on this Mac: skipped");
        return;
    }
    let size_at = |codec: VideoCodec, quality: f32| {
        let path = temporary(&format!("quality-{codec:?}-{quality}.mp4"));
        let video = VideoSettings {
            codec,
            width: 320,
            height: 240,
            bitrate: 0,
            quality: Some(quality),
            fps: FPS,
        };
        let mut writer = Writer::new(&path, Container::Mp4, &video, None).unwrap();
        add_noisy_frames(&mut writer, 0..60).unwrap();
        writer.finish().unwrap();
        std::fs::metadata(&path).unwrap().len()
    };
    for codec in [VideoCodec::Avc, VideoCodec::Hevc] {
        let (low, high) = (size_at(codec, 0.2), size_at(codec, 0.9));
        assert!(
            high > low * 2,
            "{codec:?}: {low} bytes at 0.2, {high} at 0.9"
        );
    }
}

/// A second of 64x32 frames, bright above and dark below, written as a
/// phone does one held upright: stored on its side, to be turned 90 degrees.
fn make_turned_source(stored: &Path, turned: &Path) {
    use objc2_av_foundation::{
        AVFileTypeQuickTimeMovie, AVMediaTypeVideo, AVMovieWritingOptions, AVMutableMovie,
    };
    use objc2_core_foundation::CGAffineTransform;

    let video = VideoSettings {
        codec: VideoCodec::Avc,
        width: 64,
        height: 32,
        bitrate: 2_000_000,
        quality: None,
        fps: FPS,
    };
    let mut writer = Writer::new(stored, Container::Mov, &video, None).unwrap();
    for _ in 0..30 {
        let buffer = writer.pixel_buffer().unwrap();
        with_pixels(&buffer, |pixels, row| {
            for (y, line) in pixels.chunks_exact_mut(row).enumerate() {
                let level = if y < 16 { 230 } else { 20 };
                for pixel in line.as_chunks_mut::<4>().0 {
                    *pixel = [level, level, level, 255];
                }
            }
        });
        writer.add_frame(&buffer).unwrap();
    }
    writer.finish().unwrap();

    let url = super::av::file_url(stored).unwrap();
    let movie = unsafe { AVMutableMovie::movieWithURL_options_error(&url, None) }.unwrap();
    let track = unsafe { movie.tracksWithMediaType(AVMediaTypeVideo.unwrap()) }
        .firstObject()
        .unwrap();
    // A quarter turn clockwise, moved back into view.
    let quarter = CGAffineTransform {
        a: 0.0,
        b: 1.0,
        c: -1.0,
        d: 0.0,
        tx: 32.0,
        ty: 0.0,
    };
    unsafe { track.setPreferredTransform(quarter) };
    let _ = std::fs::remove_file(turned);
    let out = super::av::file_url(turned).unwrap();
    unsafe {
        movie.writeMovieHeaderToURL_fileType_options_error(
            &out,
            AVFileTypeQuickTimeMovie.unwrap(),
            AVMovieWritingOptions::AddMovieHeaderToDestination,
        )
    }
    .unwrap();
}

#[test]
fn turns_a_source_as_it_is_shown() {
    let (stored, turned) = (temporary("stored.mov"), temporary("turned.mov"));
    make_turned_source(&stored, &turned);
    assert_eq!(
        decode::probe(&turned).unwrap(),
        Some(SourceInfo {
            width: 32,
            height: 64,
            rotation: 90
        })
    );

    let path = temporary("upright.mp4");
    let options = StartOptions {
        path: path.to_str().unwrap().to_owned(),
        format: Container::Mp4,
        width: 32,
        height: 64,
        crop: Crop::default(),
        output_width: 32,
        output_height: 64,
        fps: FPS,
        video_codec: VideoCodec::Avc,
        video_bitrate: 1_000_000,
        video_quality: None,
        audio: None,
        audio_copy: None,
    };
    let Ok(mut worker) = Worker::new(&path, &options) else {
        eprintln!("No GPU: skipped");
        return;
    };
    for i in 0..30 {
        let video = VideoFrame {
            texture_id: "video".into(),
            location: turned.clone(),
            stream: String::new(),
            time: f64::from(i) / 30.0,
        };
        let message = Message::Frame {
            frame: frame_sized("video", 32, 64),
            videos: vec![video],
            released: vec![],
        };
        worker.handle(message).unwrap();
    }
    worker.finish().unwrap();

    // Turned clockwise, what was above is on the right.
    let mut reader = VideoReader::open(&path, 0.0).unwrap();
    let (_, pixels) = reader.frame_at(0.5).unwrap().unwrap();
    let (left, right) = with_pixels(pixels, |pixels, row| {
        let at = |x: usize, y: usize| pixels[y * row + x * 4];
        (at(8, 32), at(24, 32))
    });
    assert!(right > 200 && left < 50, "left {left}, right {right}");
}
