# MagnetCut: plan

MagnetCut is a desktop video editor for macOS, Windows and Linux, forked from
[OpenCut](https://github.com/OpenCut-app/opencut-classic) (MIT). No account, no ads, no
telemetry: everything stays on the computer. Not for iOS or Android.

## Decisions

- **Shell: Tauri 2 (Rust).** The editor is ~91k lines of TypeScript that already runs in a web
  view; Tauri hosts it in the system's (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
  Linux) and gives it a Rust side. Logic keeps moving into `rust/` as upstream intended, now
  callable natively as well as through WASM. The GPUI placeholder in `apps/desktop` (a window
  with a title in it) is replaced.
- **Nothing to install for the user.** macOS: nothing. Windows 10/11 ship WebView2; the
  installer bootstraps it where it's missing. Linux: the .deb/.rpm pull in webkit2gtk and
  GStreamer from the distro. No AppImage: it would carry WebKitGTK and GTK, which are LGPL.
- **No ffmpeg.** Media goes through mediabunny (MPL-2.0) and the system's codecs (WebCodecs), so
  H.264/AAC are licensed by whoever made the OS codec, not us, and nothing GPL ships. Where a
  web view lacks a codec, the fallback is the platform's own (AVFoundation, Media Foundation,
  GStreamer) from Rust, not ffmpeg.
- **The web build is only the editor.** Removed: accounts (better-auth, Postgres, Redis), bot
  checks (botid), analytics (Databuddy), the feedback form, the Freesound sound library, the
  blog (Marble), the website pages (landing, sponsors, contributors, roadmap, brand, terms,
  privacy), the onboarding and the mobile gate. Next.js builds a static export for Tauri;
  `/editor/[id]` is `/editor?id=`. What's left that reaches the network, only when used:
  Google Fonts (the font picker), Hugging Face (Whisper models, once, for transcription) and
  Brandfetch (platform logos in the safe-area guides; to be bundled instead).
- **Updates, as in MyDiskIsFull.** The direct download checks
  `github.com/magnetcut/magnetcut/releases/latest/download/latest.json` once a day (Tauri's
  updater plugin, the cross-platform counterpart of Sparkle). The feed is a hint: an update
  installs only if it's signed with the project's Ed25519 key, whose public half is in the app.
  Only publishing a release ships it. Each copy updates from the kind of installer it came from
  (NSIS, MSI, deb, rpm; the deb and rpm ask for the administrator password). Settings
  has the daily-check switch, on by default; Settings, About and the macOS menu have Check Now.
  It's the one request made without a feature being used. The key stays on the maintainer's
  Mac: CI builds the Windows and Linux installers with no secrets, and
  `apps/desktop/scripts/release.sh` signs them (docs/RELEASING.md).
- **App Store edition.** `apps/desktop/scripts/app-store.sh` builds a sandboxed Mac App Store
  app (user-selected files and Downloads read-write, network client for model and font
  downloads), its own bundle id, no updater compiled in (`--no-default-features`), and has App
  Store Connect validate it; `--upload` sends it (docs/RELEASING.md). Same features otherwise,
  so no "Lite". Microsoft Store and Flathub can follow from the same builds.
- **About box, as in MyDiskIsFull.** Icon, name, version, the update line (direct download
  only), one sentence on what it does, a card with what it keeps on this computer (the storage
  its projects and media take, of what the web view lets it keep), "Completely free and open source, under the GNU AGPL 3.0 licence. No
  ads, no telemetry, no account.", Source, Acknowledgements (third-party notices) and "Based on OpenCut".
- **Export does HandBrake's job.** No separate converter and no queue: open a video and Export
  is the conversion. Its settings: container (MP4, MOV, MKV, WebM) and codec; quality
  (constant quality, bitrate or a target file size); size presets (4K, 1080p, 720p, phone,
  Discord/WhatsApp size) or your own size, with crop (black bars found by itself); frame rate
  (same as source, or constant/peak like HandBrake); audio (AAC or Opus, downmix,
  passthrough); subtitles embedded as soft tracks (MP4 mov_text, MKV SRT/ASS, WebM WebVTT) or
  burned in; deinterlace and denoise (GPU). Presets of your own. None of HandBrake's code: it's
  GPL and so are x264/x265. Encoders: the system's hardware ones for H.264/HEVC (fast, patents
  covered by the OS; see GPU below), and for the best quality per byte the royalty-free AV1
  (the web view's encoder, and rav1e, BSD, on a Mac, where WebKit has none) and VP9 (every web
  view's own). Not included: DVD and Blu-ray
  ripping (breaking CSS/AACS is unlawful in the EU and US, and the App Store refuses it), and
  input codecs the system can't decode (MPEG-2, WMV and DivX vary by OS).
- **Subtitles, like Jubler, synced as easily as in YouTube's editor.** A subtitle track on the
  timeline over the waveform, and beside it the list (start, end, duration, reading speed,
  text), editable in place. Open and save SRT, WebVTT, ASS/SSA, SubViewer, MicroDVD, with the
  text encoding detected. Syncing:
  - Paste plain text and it's timed to the speech (auto-sync): Whisper, already in the app and
    running on the computer, gives word timestamps, and your text is aligned to them.
  - Subtitles that are early, late or drift: fixed in one click (offset and drift fitted to the
    speech; translated subtitles too, matched to when someone speaks rather than to words), or
    by hand by marking two lines (Jubler's two-point sync).
  - Type while it plays: a line starts where you start typing, with the video pausing if you
    like (YouTube); or hold a key while a line is spoken.
  - Edges snap to where speech starts and ends and to cuts: the magnet in MagnetCut.
  - Shift, stretch, change frame rate (23.976 to 25), fix overlaps and too short or too long
    lines, split and join, translate side by side with the original.
  None of Jubler's code (GPL). Parsers and alignment live in `rust/`.
- **Transitions** (docs/TRANSITIONS.md). Between two touching clips on a video track, using the
  media past the cut (the clips' trim handles), so clips never overlap. Stored on the track,
  which gives them undo, ripple and saving. Rendered by a two-input pass in the compositor, so
  preview and export (and the native pipeline) show the same. The transitions come from the
  `gl-transitions` crate (MIT; its few BSD ones only with their notices); twelve first. 0.5 s
  centred on the cut by default, clamped to the handles there are, with an equal-power audio
  crossfade. Timing in a Rust crate.
- **GPU all the way.** Preview: the wgpu compositor already asks for WebGPU in the web view and
  falls back to WebGL2. Export and Convert run natively in Rust: the platform's hardware decoder
  (VideoToolbox, Media Foundation/D3D11, VA-API or NVDEC), then wgpu on Metal, DX12 or Vulkan
  for compositing and filters (scale, crop, colour conversion, HDR to SDR tone mapping,
  deinterlace, denoise, sharpen), then the hardware encoder (VideoToolbox: H.264, HEVC, ProRes;
  Media Foundation/NVENC/AMF/QSV and VA-API: H.264, HEVC, AV1 where the GPU has it). Frames stay
  on the GPU between them (IOSurface, D3D11 shared textures, DMA-BUF) instead of being copied
  through the CPU. The editor's Export renders with the same compositor crate built natively,
  not WebCodecs. Only the software AV1/VP9 encoders run on the CPU. All of it is OS APIs or
  MIT/BSD headers (nv-codec-headers, AMF, oneVPL, libva).
- **Licences.** MagnetCut is AGPL-3.0, like MyDiskIsFull: the editor is a web app, and the AGPL
  makes whoever hosts a modified copy share it. OpenCut's code keeps its MIT notice. The App
  Store is fine because the author holds the copyright; outside contributions come with an
  additional permission (GPLv3 section 7) for app-store distribution. Third-party code can't
  get that permission from us, so CI still fails on any GPL/LGPL/AGPL/SSPL dependency without
  a permissive alternative licence (that keeps x264/x265 out too, and their patents), and the
  third-party notices that MIT/BSD/Apache require in a binary are in About (Acknowledgements).
  Both come from `apps/web/scripts/licenses.ts`, over every Rust crate and JavaScript package
  that ships; CI fails if the notices are out of date.
  `soundtouchjs` (LGPL-2.1) is gone: pitch-preserving speed changes use a Rust time-stretch
  (`rust/crates/audio`, WSOLA).
- **Name and marks.** OpenCut's guidelines forbid its name or logo on another product, so every
  "OpenCut" goes, logos included, except credits ("Based on OpenCut") and the licence notice.
  The Rust core is built from source as `magnetcut-wasm` (`packages/wasm`), not taken from
  upstream's `opencut-wasm` npm package.

## Order

Done: 1, 2, 3, 4, 7, 8 and 10 (docs/SUBTITLES.md). 5 but for publishing 0.1.0, a draft
release on GitHub, which is the author's to do. 6 but for what's the author's in App Store
Connect: build 0.1.0 is on version 0.1.0 with its listing; the screenshots, the privacy and age
rating answers, the price and submitting it are left (docs/RELEASING.md). 9 but for a desktop of
Windows and Linux: there it's checked on CI's machines, in the app too (docs/NATIVE.md).
What's been done since 0.1.0 without the app open (the native export's panel, the subtitle
editor, the native export on Windows and Linux) is tested in code but not yet tried in the app.

1. Strip the server, accounts, analytics and website; static export; editor works in a browser.
2. Rebrand: names, package scopes, storage keys, logo and icon.
3. Tauri shell in `apps/desktop`: dev and bundle on macOS; open, edit, export a project.
4. Check WKWebView, WebView2 and WebKitGTK for WebCodecs, WebGPU/WebGL2 and OPFS; native
   fallbacks where they fall short.
5. About, Settings, updater, release script and CI (signed, notarized DMG; NSIS/MSI; deb, rpm;
   signed `latest.json`; a draft GitHub release).
6. App Store edition: entitlements, profile, upload script.
7. Licence check and notices; replace soundtouchjs.
8. Transitions: the cross-dissolve end to end, edits, audio crossfades, the Transitions tab
   and the other eleven (docs/TRANSITIONS.md has the phases).
9. The native pipeline (hardware decode, wgpu, hardware encode, zero-copy); Export moves onto
   it with HandBrake's settings, then the AV1/VP9 software encoders and the filters. First what
   stops a conversion today: media copied into the web view, and exports kept in memory
   (docs/NATIVE.md has the phases).
10. Subtitle editor and sync (docs/SUBTITLES.md has the phases).
11. Hiding faces and plates: a region blurred, pixelated or covered, keyframed, tracked, or
    found by itself (docs/HIDE.md has the phases).
12. Then: make it better.

## Web view support

From `MAGNETCUT_PROBE=1` (apps/desktop), on the app's own origin:

- macOS (WKWebView, tauri://localhost): WebGPU (Apple GPU) and WebGL2; WebCodecs encode and
  decode H.264, HEVC, VP9, AAC and Opus (no AV1 on that Mac); IndexedDB and OPFS, quota 21 GB;
  module workers. Not cross-origin isolated, so no SharedArrayBuffer: transcription runs
  single-threaded.
- Windows (WebView2, Edge 155, http://tauri.localhost; GitHub's runner): WebGL2; WebGPU, but no
  adapter (the runner has no GPU); WebCodecs encode and decode H.264, VP9, AV1, AAC and Opus, no
  HEVC (WebView2 needs a hardware decoder and Microsoft's HEVC Video Extensions); IndexedDB and
  OPFS, quota 11 GB; module workers.
- Linux (WebKitGTK on Ubuntu 24.04, tauri://localhost): WebGL2, no WebGPU (off in WebKitGTK).
  The Storage API, the file system and access handles are off by default: the app switches them
  on (`apps/desktop/src/webkit.rs`), and OPFS works, quota 1 GB (`createWritable` only appears
  with access handles on; sync access handles themselves answer "Backend does not support this
  operation"). Where a web view has sync access handles but no `createWritable`, as older
  WKWebView releases may, the app writes through a worker (`services/storage/opfs-write-worker.ts`). WebCodecs goes through GStreamer: with the base plugins only, it encodes VP9 and
  Opus and decodes Opus; with `gstreamer1.0-plugins-bad` and `gstreamer1.0-libav`, everything
  (H.264, HEVC, VP9, AV1, AAC and Opus, both ways). The deb and rpm recommend those packages,
  which apt and dnf install by default; without them, importing a video says what to install.

## Risks

- Imported media is copied into the web view's storage (OPFS): quota 21 GB on macOS, 11 GB on
  the Windows runner, 1 GB on Linux, where a large file won't fit. The desktop app should
  reference media files where they are, through Rust, instead (step 9 reads them natively).

- WKWebView and WebKitGTK are not Chrome (upstream recommends Chrome). Step 4 decides how much
  needs native fallbacks.
- Hardware H.264/HEVC is fast but needs more bits than x264/x265 for the same quality; AV1 in
  software is where MagnetCut matches HandBrake's quality, slower.
- Linux decoding depends on the distro's GStreamer plugins. The packages recommend them, but
  H.264 is often missing on Fedora and openSUSE for patent reasons (Fedora has an openh264
  plugin, RPM Fusion the rest).
