// The native export on macOS (docs/NATIVE.md, phase 4). The editor describes
// each frame, as it does for its own compositor, with its videos as
// references (file, time); here AVFoundation decodes them, the compositor
// draws the frame on the GPU and AVFoundation encodes it. Only descriptions,
// the editor's own drawings (text, shapes, masks) and the mixed sound cross
// from the web view: no frame does, which at 4K cost more than drawing it.

mod av;
mod av1;
mod decode;
mod encode;
mod frames;
#[cfg(test)]
mod tests;
mod turn;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use compositor::FrameDescriptor;
use gpu::GpuContext;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use crate::activity::Activity;
use crate::export::Exports;
use crate::media::MediaFiles;
use decode::{SourceInfo, VideoReader};
use encode::{Audio, AudioSettings, Container, FrameRate, VideoCodec, VideoSettings, Writer};
use frames::{Crop, FrameRenderer, Pixels, UploadedFrames};

/// The exports being made, by id.
#[derive(Default)]
pub struct NativeExports {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

struct Session {
    sender: SyncSender<Message>,
    worker: JoinHandle<()>,
    /// Why the export stopped, once it has.
    failure: Arc<Mutex<Option<String>>>,
    path: PathBuf,
    _activity: Activity,
}

enum Message {
    Texture {
        id: String,
        width: u32,
        height: u32,
        /// RGBA, straight alpha, as the editor's canvases give it.
        pixels: Vec<u8>,
    },
    Frame {
        frame: FrameDescriptor,
        videos: Vec<VideoFrame>,
        released: Vec<String>,
    },
    /// The mix's next samples: float, interleaved; and whether they're its last.
    Audio {
        samples: Vec<f32>,
        is_last: bool,
    },
    Finish(mpsc::Sender<Result<(), String>>),
}

struct VideoFrame {
    texture_id: String,
    location: PathBuf,
    stream: String,
    time: f64,
}

// Frames described ahead of those encoded: the editor's work overlaps ours.
const QUEUE: usize = 3;

// Frames after which a source not drawn is closed, with its decoder.
const IDLE_FRAMES: u64 = 120;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the native export can do on this Mac, besides H.264, HEVC and ProRes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    constant_quality: bool,
}

#[tauri::command]
pub fn native_export_capabilities() -> Capabilities {
    Capabilities {
        constant_quality: encode::constant_quality(),
    }
}

/// What each source is, by the path the editor knows it by: none for one
/// AVFoundation can't decode, or the editor hasn't been given.
#[tauri::command]
pub async fn native_export_probe(
    media: State<'_, MediaFiles>,
    paths: Vec<String>,
) -> Result<Vec<Option<SourceInfo>>, String> {
    let locations: Vec<Option<PathBuf>> = paths.iter().map(|path| media.location(path)).collect();
    tauri::async_runtime::spawn_blocking(move || {
        locations
            .iter()
            .map(|location| {
                let info = location.as_deref().map(decode::probe).transpose();
                // A file that won't open is one the web view's export may manage.
                info.unwrap_or(None).flatten()
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    /// A file picked in the save dialog: used up.
    path: String,
    format: Container,
    /// The project's size, which frames are drawn at.
    width: u32,
    height: u32,
    #[serde(default)]
    crop: Crop,
    /// The size encoded.
    output_width: u32,
    output_height: u32,
    fps: FrameRate,
    video_codec: VideoCodec,
    /// In bits a second.
    video_bitrate: u32,
    /// Constant quality instead, from 0 to 1, where the Mac takes it.
    #[serde(default)]
    video_quality: Option<f32>,
    /// AAC, from the mix the editor sends.
    audio: Option<AudioSettings>,
    /// Or a source's sound, copied: the timeline's when it plays it uncut.
    #[serde(default)]
    audio_copy: Option<AudioCopy>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCopy {
    /// A file the editor was given; once checked, where it is.
    path: PathBuf,
    /// In seconds: where the timeline stops hearing it.
    end: f64,
}

/// Starts an export: its id, once the GPU and the file are ready.
#[tauri::command]
pub async fn native_export_start(
    exports: State<'_, Exports>,
    native: State<'_, NativeExports>,
    media: State<'_, MediaFiles>,
    mut options: StartOptions,
) -> Result<u32, String> {
    if let Some(copy) = &mut options.audio_copy {
        let path = copy
            .path
            .to_str()
            .ok_or("a source the editor wasn't given")?;
        copy.path = media
            .location(path)
            .ok_or("a source the editor wasn't given")?;
    }
    let path = PathBuf::from(&options.path);
    exports.take_pick(&path)?;
    let (sender, receiver) = mpsc::sync_channel(QUEUE);
    let (ready_sender, ready) = mpsc::channel();
    let failure = Arc::new(Mutex::new(None));
    let worker = {
        let failure = Arc::clone(&failure);
        let path = path.clone();
        thread::Builder::new()
            .name("export".into())
            .spawn(move || run(&path, &options, &receiver, &ready_sender, &failure))
            .map_err(|error| error.to_string())?
    };
    let started = tauri::async_runtime::spawn_blocking(move || ready.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "the export stopped as it started".to_owned())
        .and_then(|result| result);
    if let Err(error) = started {
        drop(sender);
        let _ = worker.join();
        return Err(error);
    }
    let id = native.next_id.fetch_add(1, Ordering::Relaxed);
    lock(&native.sessions).insert(
        id,
        Session {
            sender,
            worker,
            failure,
            path,
            _activity: Activity::begin("Exporting a film"),
        },
    );
    Ok(id)
}

/// One of the editor's drawings, for the frames that follow: the body is its
/// RGBA pixels; the `session`, `texture-id`, `width` and `height` headers say
/// what it is.
#[tauri::command]
pub async fn native_export_texture(
    native: State<'_, NativeExports>,
    request: Request<'_>,
) -> Result<(), String> {
    let header = |name: &str| -> Result<&str, String> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("no {name} header"))
    };
    let number = |name: &str| -> Result<u32, String> {
        header(name)?
            .parse()
            .map_err(|_| format!("the {name} header isn't a number"))
    };
    let (session, width, height) = (number("session")?, number("width")?, number("height")?);
    let id = header("texture-id")?.to_owned();
    let InvokeBody::Raw(pixels) = request.body() else {
        return Err("the pixels aren't raw bytes".into());
    };
    if pixels.len() != (width as usize) * (height as usize) * 4 {
        return Err("the pixels aren't the size given".into());
    }
    let message = Message::Texture {
        id,
        width,
        height,
        pixels: pixels.clone(),
    };
    send(&native, session, message).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoReference {
    /// The texture the frame goes in, as the frame's layers name it.
    texture_id: String,
    path: String,
    /// Which of the file's decoders: two clips of a file in a transition
    /// each need their own.
    #[serde(default)]
    stream_key: String,
    /// In the source, in seconds.
    time: f64,
}

/// The next frame: drawn as described, with these videos' pictures at those
/// times, once the drawings no longer used are let go.
#[tauri::command]
pub async fn native_export_frame(
    native: State<'_, NativeExports>,
    media: State<'_, MediaFiles>,
    session: u32,
    frame: FrameDescriptor,
    videos: Vec<VideoReference>,
    released: Vec<String>,
) -> Result<(), String> {
    let videos = videos
        .into_iter()
        .map(|video| {
            Ok(VideoFrame {
                location: media
                    .location(&video.path)
                    .ok_or("a source the editor wasn't given")?,
                texture_id: video.texture_id,
                stream: video.stream_key,
                time: video.time,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let message = Message::Frame {
        frame,
        videos,
        released,
    };
    send(&native, session, message).await
}

/// The mix's next samples: the body is 32-bit floats, interleaved, little
/// endian; the `session` header says whose, and `last` (`true`) that they
/// end it.
#[tauri::command]
pub async fn native_export_audio(
    native: State<'_, NativeExports>,
    request: Request<'_>,
) -> Result<(), String> {
    let session = request
        .headers()
        .get("session")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or("no session header")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the samples aren't raw bytes".into());
    };
    let is_last = request
        .headers()
        .get("last")
        .is_some_and(|value| value == "true");
    let samples = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&sample| f32::from_le_bytes(sample))
        .collect();
    send(&native, session, Message::Audio { samples, is_last }).await
}

/// Finishes the file, which can then be shown.
#[tauri::command]
pub async fn native_export_finish(
    exports: State<'_, Exports>,
    native: State<'_, NativeExports>,
    session: u32,
) -> Result<(), String> {
    let session = lock(&native.sessions)
        .remove(&session)
        .ok_or("no such export")?;
    let (reply, finished) = mpsc::channel();
    // The activity lasts until the file's finished.
    let Session {
        sender,
        worker,
        failure,
        path,
        _activity,
    } = session;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let sent = sender.send(Message::Finish(reply));
        let result = match sent {
            Ok(()) => finished.recv().unwrap_or_else(|_| Err(String::new())),
            Err(_) => Err(String::new()),
        };
        drop(sender);
        let _ = worker.join();
        result.map_err(|error| lock(&failure).clone().unwrap_or(error))
    })
    .await
    .map_err(|error| error.to_string())?;
    result?;
    exports.add_saved(path);
    Ok(())
}

/// Stops an export, deleting what it had written.
#[tauri::command]
pub async fn native_export_cancel(
    native: State<'_, NativeExports>,
    session: u32,
) -> Result<(), String> {
    let Some(session) = lock(&native.sessions).remove(&session) else {
        return Ok(());
    };
    // Without a Finish, the worker cancels and deletes the file.
    let Session { sender, worker, .. } = session;
    drop(sender);
    tauri::async_runtime::spawn_blocking(move || worker.join())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "the export stopped badly".to_owned())
}

/// Hands a message to the export's thread, waiting while it's behind: why
/// it stopped, if it has.
async fn send(native: &NativeExports, session: u32, message: Message) -> Result<(), String> {
    let (sender, failure) = {
        let sessions = lock(&native.sessions);
        let session = sessions.get(&session).ok_or("no such export")?;
        (session.sender.clone(), Arc::clone(&session.failure))
    };
    let sent = tauri::async_runtime::spawn_blocking(move || sender.send(message))
        .await
        .map_err(|error| error.to_string())?;
    sent.map_err(|_| {
        lock(&failure)
            .clone()
            .unwrap_or_else(|| "the export stopped".to_owned())
    })
}

/// The export's thread: the GPU, the decoders and the encoder are all its own.
fn run(
    path: &Path,
    options: &StartOptions,
    receiver: &Receiver<Message>,
    ready: &mpsc::Sender<Result<(), String>>,
    failure: &Mutex<Option<String>>,
) {
    let mut worker = match Worker::new(path, options) {
        Ok(worker) => worker,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    for message in receiver {
        let result = match message {
            Message::Finish(reply) => {
                let result = worker.finish();
                if let Err(error) = &result {
                    *lock(failure) = Some(error.clone());
                    let _ = std::fs::remove_file(path);
                }
                let _ = reply.send(result);
                return;
            }
            message => worker.handle(message),
        };
        if let Err(error) = result {
            *lock(failure) = Some(error);
            break;
        }
    }
    // Cancelled, or stopped by an error: nothing's kept.
    worker.cancel();
    let _ = std::fs::remove_file(path);
}

struct Worker {
    renderer: FrameRenderer,
    writer: Option<Writer>,
    sources: Sources,
    uploaded: UploadedFrames,
}

impl Worker {
    fn new(path: &Path, options: &StartOptions) -> Result<Self, String> {
        let context =
            futures_executor::block_on(GpuContext::new()).map_err(|error| error.to_string())?;
        let output_size = (options.output_width, options.output_height);
        let renderer = FrameRenderer::new(
            context,
            (options.width, options.height),
            options.crop,
            output_size,
        )?;
        let video = VideoSettings {
            codec: options.video_codec,
            width: output_size.0,
            height: output_size.1,
            bitrate: options.video_bitrate,
            // rav1e keeps a quality on any Mac; AVFoundation, on Apple silicon.
            quality: options
                .video_quality
                .filter(|_| options.video_codec == VideoCodec::Av1 || encode::constant_quality()),
            fps: options.fps,
        };
        let audio = match (&options.audio_copy, options.audio) {
            (Some(copy), _) => Some(Audio::Copy {
                location: copy.path.clone(),
                end: copy.end,
            }),
            (None, Some(settings)) => Some(Audio::Mix(settings)),
            (None, None) => None,
        };
        let writer = Writer::new(path, options.format, &video, audio)?;
        Ok(Self {
            renderer,
            writer: Some(writer),
            sources: Sources::default(),
            uploaded: UploadedFrames::default(),
        })
    }

    fn writer(&mut self) -> Result<&mut Writer, String> {
        self.writer
            .as_mut()
            .ok_or_else(|| "the export is over".to_owned())
    }

    fn handle(&mut self, message: Message) -> Result<(), String> {
        match message {
            Message::Texture {
                id,
                width,
                height,
                mut pixels,
            } => {
                frames::rgba_to_bgra(&mut pixels);
                self.uploaded.remove(&id);
                self.renderer.upload(
                    &id,
                    Pixels {
                        width,
                        height,
                        bytes_per_row: width * 4,
                        data: &pixels,
                    },
                );
                Ok(())
            }
            Message::Frame {
                frame,
                videos,
                released,
            } => self.frame(&frame, &videos, &released),
            Message::Audio { samples, is_last } => self.writer()?.add_audio(&samples, is_last),
            Message::Finish(_) => Ok(()),
        }
    }

    fn frame(
        &mut self,
        frame: &FrameDescriptor,
        videos: &[VideoFrame],
        released: &[String],
    ) -> Result<(), String> {
        for id in released {
            self.renderer.release(id);
            self.uploaded.remove(id);
        }
        for video in videos {
            let (source, reader) =
                self.sources
                    .reader(&video.location, &video.stream, video.time)?;
            let rotation = reader.rotation();
            match reader.frame_at(video.time)? {
                Some((time, pixels)) if !self.uploaded.has(&video.texture_id, source, time) => {
                    self.renderer
                        .upload_pixel_buffer(&video.texture_id, pixels, rotation)?;
                    self.uploaded.set(&video.texture_id, source, time);
                }
                // A source with no pictures at all shows nothing.
                None if !self.renderer.has_texture(&video.texture_id) => {
                    self.renderer.upload(
                        &video.texture_id,
                        Pixels {
                            width: 2,
                            height: 2,
                            bytes_per_row: 8,
                            data: &frames::clear_pixels(2, 2),
                        },
                    );
                }
                _ => {}
            }
        }
        self.sources.close_idle();
        let buffer = self.writer()?.pixel_buffer()?;
        self.renderer.render(frame, &buffer)?;
        self.writer()?.add_frame(&buffer)
    }

    fn finish(&mut self) -> Result<(), String> {
        self.writer.take().ok_or("the export is over")?.finish()
    }

    fn cancel(&mut self) {
        if let Some(writer) = self.writer.take() {
            writer.cancel();
        }
    }
}

/// The sources' decoders, by file and stream, each closed once it's idle.
#[derive(Default)]
struct Sources {
    ids: HashMap<(PathBuf, String), usize>,
    open: HashMap<usize, (VideoReader, u64)>,
    frame: u64,
}

impl Sources {
    /// The decoder for a file's stream, its id, opened at `time` if it isn't.
    fn reader(
        &mut self,
        location: &Path,
        stream: &str,
        time: f64,
    ) -> Result<(usize, &mut VideoReader), String> {
        let next = self.ids.len();
        let id = *self
            .ids
            .entry((location.to_owned(), stream.to_owned()))
            .or_insert(next);
        let entry = match self.open.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert((VideoReader::open(location, time)?, self.frame))
            }
        };
        entry.1 = self.frame;
        Ok((id, &mut entry.0))
    }

    fn close_idle(&mut self) {
        let frame = self.frame;
        self.open.retain(|_, (_, used)| frame - *used < IDLE_FRAMES);
        self.frame += 1;
    }
}
