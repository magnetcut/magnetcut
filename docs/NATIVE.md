# The native pipeline and Export

`docs/PLAN.md` step 9: hardware decode, wgpu, hardware encode, zero-copy, and Export with
HandBrake's settings. This is from a reading of the code and of mediabunny 1.41; what's built is
under Done.

## In short

Export today can't convert a film. It renders each frame in the web view, encodes it with
WebCodecs and keeps the whole file in memory (mediabunny's `BufferTarget`), after mixing the
whole soundtrack into one `AudioBuffer`: two hours at 8 Mbit/s is 7 GB of video and 2.8 GB of
audio in the web view before anything reaches the disk. The film has to be copied into the web
view's storage first, and Linux gives that 1 GB. Its settings are MP4 or WebM and four
qualities.

So the order is what stops a conversion first, then the settings, then the native pipeline:

1. **Media where it is.** On the desktop, an imported file stays where it is and is read
   through Rust, by range, instead of being copied into OPFS.
2. **Export to a file, as it goes.** A save dialog; the muxer writes to the file through Rust
   while it encodes; the audio is mixed and encoded in pieces.
3. **HandBrake's settings**, on the encoders the web view has.
4. **The native pipeline on macOS**: VideoToolbox decode, the compositor on Metal, VideoToolbox
   encode, frames on the GPU throughout. Export moves onto it there.
5. **Windows and Linux natively**: Media Foundation, GStreamer (the system's, as WebKitGTK uses).
6. **Software AV1 and VP9**, and the filters (deinterlace, denoise, sharpen, HDR to SDR).

1 to 3 make Export do HandBrake's job on every system with what's there; 4 to 6 make it fast
and give it constant quality and the encoders the web views lack.

## What's there

### Media
- A `MediaAsset` holds a `File` (`media/types.ts`). Import copies it into OPFS
  (`services/storage/service.ts`); opening a project reads it back as a `File`.
- Fifteen places read `asset.file`: mediabunny `Input`s over a `BlobSource` (video cache,
  audio, metadata), object URLs for images, the storage service. mediabunny also reads from a
  `UrlSource` (HTTP range requests) or a `StreamSource` (a read callback): either can stand in
  for `BlobSource` without the decoders knowing.
- Quotas from the probe: 21 GB on macOS, 11 GB on the Windows runner, 1 GB on Linux.

### Export
- `RendererManager.exportProject` (`core/managers/renderer-manager.ts`) builds the scene, mixes
  the audio with `createTimelineAudioBuffer`, and runs `SceneExporter`
  (`services/renderer/scene-exporter.ts`): for each frame, `CanvasRenderer.render`, then
  mediabunny's `CanvasSource` encodes the canvas. H.264 in MP4, VP9 in WebM; AAC or Opus.
- The result is an `ArrayBuffer`, handed to `downloadBuffer` (`export/index.ts`), an `<a
  download>`: the web view's downloads, so ~/Downloads, with no choice of where.
- The UI is a popover (`components/editor/export-button.tsx`): format, quality, audio on/off.

### What mediabunny can do already
- Output: MP4, MOV, MKV, WebM, MPEG-TS, Ogg, WAV, FLAC, ADTS.
- `StreamTarget`: chunks with their positions, written as they come (MP4 needs `fastStart:
  false` or "fragmented" for that, since the index goes at the end or in fragments).
- Encoding options: codec, bitrate as a number or a `Quality` (scaled by size and codec),
  `bitrateMode` constant or variable, key-frame interval, hardware preference. **No constant
  quality**: WebCodecs' quantizer mode isn't exposed, and only Chromium has it.
- `getEncodableVideoCodecs`/`canEncodeVideo` say what the web view encodes at a size.
- `TextSubtitleSource`: soft subtitle tracks (step 10).
- `EncodedVideoPacketSource`/`EncodedAudioPacketSource`: mux packets encoded elsewhere, such as
  audio passthrough from the source file.

### The compositor
- Each frame is a `FrameDescriptor` (items, transforms, effects, masks, transitions) plus the
  textures it uses (`services/renderer/compositor/frame-descriptor.ts`), rendered by the Rust
  compositor (`rust/crates/compositor`). The descriptor is data; the textures are canvases:
  video frames from the decoder cache, and text, images, stickers and graphics drawn in 2D.
- The crate builds natively as well as to WebAssembly. Natively it needs its textures from
  somewhere else: video from a native decoder, the rest drawn by the web view and sent once.

## The phases

### 1. Media where it is
- Desktop only; the web build keeps OPFS. An asset gets `path`, and its file is a `DiskFile`
  (`media/disk-file.ts`) where it was a `File`: mediabunny reads it through a `StreamSource`
  whose reads are IPC calls returning bytes (`read_media_file`, at most 64 MB each), not a
  custom protocol, which would have needed CORS for the canvas and range handling. Images are
  read into memory once, as they're drawn from object URLs.
- Rust (`apps/desktop/src/media.rs`) reads only files the user gave: picked in the open dialog
  or dropped. The list survives a relaunch (`media-files.json` in the app's data folder), on
  macOS with a security-scoped bookmark each, which the App Store sandbox needs to open a file
  again (entitlement `com.apple.security.files.bookmarks.app-scope`), and which follows a file
  that's moved or renamed.
- Import: the Import button opens the app's dialog. Drops arrive as HTML5 `File`s, whose paths
  WebKit hides; on macOS they're on the drag pasteboard, which Rust reads, and the editor
  matches them by name and size. On Windows and Linux a dropped file is still copied.
- A file that's gone when the project opens: a toast names it, and its clips stay empty until
  it's back. Relink, to point at it somewhere else, is still to do.

### 2. Export to a file, as it goes
- In the desktop app, Export opens a save dialog first (Tauri's dialog plugin), with the
  container's extension, in the folder of the project's first file on disk, as HandBrake does.
  The App Store edition may write what's picked (`files.user-selected.read-write`).
- mediabunny writes through a `StreamTarget` in 16 MB chunks (`export/disk-target.ts`), each
  sent to Rust as the raw body of an IPC call with its position in a header; Rust
  (`apps/desktop/src/export.rs`) writes it there, and only to a file picked in the dialog. MP4
  puts its index at the end (`fastStart: false`), so nothing is held back. A cancelled or failed
  export deletes its file; a finished one gets a toast with Show in Finder. The web build keeps
  `BufferTarget` and the download.
- H.264 in WebKit (macOS, and Safari) is Baseline. Measured in the app's web view: in the
  High and Main profiles, which mediabunny asks for, the encoder puts out nothing, even when
  flushed, so every MP4 export stopped after a few frames, 0.1.0's too; in real time it
  encodes High but drops frames after each key frame. Baseline puts out every frame, at 4K
  too. `onEncoderConfig` swaps the profile and keeps mediabunny's level.
- The soundtrack is mixed ten seconds at a time (`media/audio-mix.ts`), a window ahead of the
  frames, and handed to the encoder as it goes. Each clip's source is decoded by mediabunny
  as the windows reach it, through one iterator from its first window to its last, and
  resampled with a little either side; the mixer is the one the whole mix used, given an
  offset into the output and the source. Each window goes through playback's limiter after
  the last second of the window before, which the limiter hears and drops, so windows join
  as if mastered whole. Decoded whole as before: library sounds, audio files WebCodecs
  doesn't decode, and clips whose speed changes with their pitch kept (the stretcher takes a
  clip at once). Transcription's mix is built from the same windows.
- The timeline's waveforms are built the same way, a decoded buffer at a time
  (`WaveformSummaryBuilder`), at the file's own rate; only an audio file WebCodecs doesn't
  decode is read whole.

### 3. HandBrake's settings
- Container: MP4, MOV, MKV, WebM. Codec: H.264, HEVC, VP9, AV1, each container offering what
  players expect in it (`export/settings.ts`); a codec the web view can't encode at the size
  chosen is greyed out (asked with `canEncodeVideo`, not assumed).
- Quality: a level, an average bitrate, or a file size. All three become a bitrate before
  anything is encoded: a level is mediabunny's own sum (3 Mbit/s for medium H.264 at 1080p,
  scaled by the picture and the codec; a test keeps the two equal), a file size what's left
  after the audio and about 1% for the container, encoded at a constant bitrate.
- Size: the full picture, 4K, 1440p, 1080p, 720p or 480p by the shorter side (so a portrait
  project stays portrait), or a width or height of your own, the shape kept; never larger than
  the picture, in even numbers. The compositor still draws at the project's size, and each
  frame is cropped and scaled onto a canvas of the size encoded.
- Crop: pixels off each side, typed or found. Find black bars renders twelve frames across the
  timeline as they'd be exported and keeps the rows and columns along the edges that are black
  in every frame with a picture (dark on average and nowhere bright, which allows for a
  compressed source's noise; `export/black-bars.ts`), in even numbers, and none if they'd take
  most of the picture. The crop belongs to the film, so it isn't kept with the settings.
- Frame rate: the project's or another, constant (23.976 to 60).
- Audio: AAC or Opus, the bitrate, stereo or mono (the mix downmixed); or the source's sound
  copied, as HandBrake's passthru does, when the whole soundtrack is one file's, uncut (one
  clip heard, from the start of the timeline and of its file, no speed change or crossfade,
  at 0 dB without keyframes; it may stop early) in a codec the container takes
  (`export/passthrough.ts`). Its packets go into the file as they are, a little ahead of the
  frames, through the one the soundtrack ends in. Packets before zero, the encoder's priming
  that the source's edit list hides, are left out: mediabunny writes no edit lists.
- The panel says what it'll make (codec, size, rate, sound, about how big) before it starts.
- Presets: Default, Fast 1080p, Small 720p, Fits in 25 MB, Fits in 10 MB, Web 1080p (WebM)
  and Archive (HEVC), one greyed out where its codec can't be encoded; and your own, saved
  from the panel. The panel's choices are kept for the next export, presets with them, in
  local storage (`export/choices-store.ts`), and checked field by field when read back.

### 4. Natively on macOS
- `rust/crates/media` (new): decode with VideoToolbox (`objc2-video-toolbox`, MIT), frames as
  `CVPixelBuffer`s on IOSurfaces, imported into wgpu as Metal textures (no copy).
- The web view still resolves the timeline into frame descriptors and draws the non-video
  textures; it sends them to Rust (a texture only when it changes). Rust decodes the video,
  composites with the same crate on Metal and encodes with VideoToolbox: constant quality
  (`kVTCompressionPropertyKey_Quality`), H.264, HEVC (10-bit too) and ProRes; muxed natively.
- What the web view can't decode (ProRes, DNxHR) works there too.

### 5. Windows and Linux
- Windows: Media Foundation through the `windows` crate (MIT/Apache): source reader with D3D11
  for decode, sink writer with the hardware encoders (NVENC, AMF, QSV behind MF).
- Linux: GStreamer, the system's (LGPL, not shipped, as with WebKitGTK; bindings MIT/Apache):
  VA-API decode and encode where the plugins are, else software decode.
- Checked only on CI and the probe: no local Windows or Linux machine.

### 6. Software encoders and filters
- AV1 with rav1e (BSD-2) and VP9 with libvpx (BSD-3), where the system has no hardware encoder.
- Filters as compositor passes: deinterlace (yadif-like, written anew), denoise, sharpen,
  HDR to SDR tone mapping.

## Risks
- The App Store sandbox and bookmarks: a project made in the direct download and opened in the
  store edition has no bookmarks; it asks for the files again.
- Whether a file dropped on the App Store edition can be read: the sandbox grants a dropped
  file to whoever reads it from the drag pasteboard, which WebKit does in the app's process; not
  tried yet (no store profile).
- Export's sound now always goes through the limiter, as playback's does: before, only a mix
  that peaked over 0.98 did. A quiet mix comes out about 0.5 dB louder (the limiter's makeup
  gain) and 6 ms later (its lookahead), as it plays in the editor.
- H.264 Baseline gives less quality for its bitrate than High, until phase 4 encodes natively.
- Copied sound skips the limiter, so it's the file's, not quite as it played in the editor
  (half a decibel at most), and without the priming packets its first milliseconds decode a
  little differently.
- A file size is a ceiling, not a promise: WebKit's encoder spends less than the constant
  bitrate asked for on a picture that's easy to encode (1 MB asked, 745 KB made, on a test
  pattern). It isn't meant to go over.
- Constant quality waits for phase 4: until then quality is a bitrate.
- What the editor may read is decided in Rust, but a script running in the web view could still
  ask for the files of the last drag made anywhere, or read files given to other projects. Only
  media files are granted, each drag's once; still to do: forget a file when no project uses it,
  and a content security policy (none today: it would have to allow the fonts and models the
  editor fetches).
- Native code for Windows and Linux written without the machines to try it on.

## Done
- Phase 1 but for Relink and drops on Windows and Linux. Checked in the app on macOS (a test
  page, then the editor's own import code, run in the web view): a dropped 1080p file found on
  disk, imported with its thumbnail in 0.1 s, saved by path and reopened from it, frames
  decoded at 1.8 ms each through IPC reads; other paths refused; the list and the bookmark
  surviving a relaunch and a rename.
- Phase 2. In the app on macOS: a save dialog opening in the folder given, and an MP4 written
  to the file picked as it was encoded, which mediabunny then read back whole. A 25 s timeline
  of two AAC tones at 48 kHz, one over the other, mixed in three windows: as long as the
  timeline to the sample, the joins as smooth as the tone, the limiter holding the peak under
  0.98 across them. Exported at 320x180 and 1920x1080 with that soundtrack: every frame
  (750), the sound whole, 1080p at 2.2 times real time.
- Phase 3. In the app on macOS, a 4 s 720p
  timeline exported seven ways: HEVC in MP4; H.264 in MOV at 480p with mono AAC; H.264 and
  AAC in MKV; VP9 and Opus in MKV and, mono, in WebM; HEVC in MOV at 25 fps from a 30 fps
  timeline, at 3 Mbit/s (2.98 made); H.264 to fit in 1 MB. Every frame in each (120, and 100
  at 25 fps), with the codec, size and channels asked for; the MP4s and MOVs play in
  AVFoundation (HEVC as `hvc1`), and the 480p frame is the whole picture, scaled. AV1 is the
  one codec this Mac's web view doesn't encode. Presets, in Chrome: chosen, saved, kept
  across a reload with the last choices, and removed. A 16:9 clip on black in a 4:3 project:
  bars of 120 found at top and bottom in all twelve frames, in 0.8 s, and the export cropped to
  the clip and scaled to 854x480, every frame, with no black left. A clip's AAC sound copied
  into MP4 and MKV: all 188 packets from zero byte for byte as in the source and at its times
  (the priming packet at -21 ms left out), the MP4's sound ending at 4.000 s with the picture.
