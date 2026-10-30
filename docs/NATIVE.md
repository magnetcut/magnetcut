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
- Desktop only; the web build keeps OPFS. An asset gets `path` (and on macOS, a
  security-scoped bookmark, which the App Store sandbox needs to reopen it after a relaunch:
  entitlement `com.apple.security.files.bookmarks.app-scope`).
- Rust serves files on a custom protocol with range requests; the web view reads them with
  mediabunny's `UrlSource`, and images by URL. Only files the user opened or dropped: the
  protocol refuses other paths (a list kept by Rust, from the dialog and drop events).
- Import by Tauri's drop events and an open dialog, which give paths.
- A file that has moved or gone: the project says so and offers to find it (Relink).

### 2. Export to a file, as it goes
- A save dialog (Tauri's dialog plugin, MIT/Apache) with the container's extension; the App
  Store edition gets write access to what's picked.
- `StreamTarget` → Rust writes each chunk at its position. The web keeps `BufferTarget` and
  the download.
- Audio mixed per stretch (a few seconds at a time) through the same mixer, fed to an
  `AudioSampleSource`.

### 3. HandBrake's settings
- Container: MP4, MOV, MKV, WebM. Codec: H.264, HEVC, VP9, AV1, as the web view can encode
  them at the chosen size (asked, not assumed).
- Quality: a level (mediabunny's `Quality`), an average bitrate, or a target file size (the
  bitrate that fits, after the audio).
- Size: the project's, presets (4K, 1080p, 720p, 480p, phone, "fits in 25 MB" for Discord),
  or your own, keeping the aspect ratio; crop, with black bars found from sampled frames.
- Frame rate: the project's or another, constant.
- Audio: AAC or Opus, bitrate, stereo or mono; passthrough when the soundtrack is one source's
  audio uncut, through `EncodedAudioPacketSource`.
- Presets of your own, in local storage, and the last settings remembered.
- The export window says what it'll make (codec, size, rate, estimated size) before it starts.

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
- WKWebView's custom-protocol responses are whole bodies in memory per request: range requests
  must stay small (mediabunny reads in chunks, so they do).
- Constant quality waits for phase 4: until then quality is a bitrate.
- Native code for Windows and Linux written without the machines to try it on.

## Done
Nothing yet.
