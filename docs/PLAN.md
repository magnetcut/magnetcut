# MagnetCut: plan

MagnetCut is a desktop video editor for macOS, Windows and Linux, forked from
[OpenCut](https://github.com/OpenCut-app/opencut-classic) (MIT). No account, no ads, no
telemetry by default. Crash reporting is an explicit opt-in (docs/CRASH_REPORTING.md).
Not for iOS or Android.

## Decisions

- **Shell: Tauri 2 (Rust).** The editor is ~91k lines of TypeScript that already runs in a web
  view; Tauri hosts it in the system's (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
  Linux) and gives it a Rust side. Logic keeps moving into `rust/` as upstream intended, now
  callable natively as well as through WASM. The GPUI placeholder in `apps/desktop` (a window
  with a title in it) is replaced.
- **Nothing to install for the user.** macOS: nothing. Windows 10/11 ship WebView2; the
  installer bootstraps it where it's missing. Linux: the .deb/.rpm pull in webkit2gtk and
  GStreamer from the distro. No AppImage: it would carry WebKitGTK and GTK, which are LGPL.
  OpenSSL (Apache-2.0, for TLS) is linked in: its soname changes with each major version, and
  Ubuntu 26.10 has only OpenSSL 4. The release run fails if the app needs a system libssl.
- **No ffmpeg.** Media goes through mediabunny (MPL-2.0) and the system's codecs (WebCodecs), so
  H.264/AAC are licensed by whoever made the OS codec, not us, and nothing GPL ships. Where a
  web view lacks a codec, the fallback is the platform's own (AVFoundation, Media Foundation,
  GStreamer) from Rust, not ffmpeg.
- **The web build is only the editor.** Removed: accounts (better-auth, Postgres, Redis), bot
  checks (botid), analytics (Databuddy), the feedback form, the Freesound sound library, the
  blog (Marble), the website pages (landing, sponsors, contributors, roadmap, brand, terms,
  privacy), the onboarding and the mobile gate. Next.js builds a static export for Tauri;
  `/editor/[id]` is `/editor?id=`. What's left that reaches the network, only when used:
  Google Fonts (the font picker), Hugging Face (Whisper models, and the face and plate
  detection models, once each), jsDelivr (the runtime transformers.js runs Whisper with, once),
  Brandfetch (platform logos in the safe-area guides; to be bundled instead), and ElevenLabs
  and OpenAI (voices for the subtitles, with the user's own key; docs/VOICEOVER.md).
- **Updates, as in MyDiskIsFull.** The direct download checks
  `github.com/magnetcut/magnetcut/releases/latest/download/latest.json` once a day (Tauri's
  updater plugin, the cross-platform counterpart of Sparkle). The feed is a hint: an update
  installs only if it's signed with the project's Ed25519 key, whose public half is in the app.
  Only publishing a release ships it. Each copy updates from the kind of installer it came from
  (NSIS, MSI, deb, rpm; the deb and rpm ask for the administrator password). Settings
  has the daily-check switch, on by default; Settings, About and the macOS menu have Check Now.
  It's the one request made without a feature being used. The release workflow builds,
  notarizes and signs it all with its environment's secrets, as MyDiskIsFull's does; a Mac with
  the keys can too, with `apps/desktop/scripts/release.sh` (docs/RELEASING.md).
- **App Store edition.** `apps/desktop/scripts/app-store.sh` builds a sandboxed Mac App Store
  app (user-selected files and Downloads read-write, Music read-write for recordings, the
  microphone, network client for model and font downloads and voices), its own bundle id, no
  updater compiled in (`--no-default-features`), and has App Store Connect validate it;
  `--upload` sends it (docs/RELEASING.md). Same features otherwise, so no "Lite". Microsoft
  Store and Flathub can follow from the same builds.
- **About box, as in MyDiskIsFull.** Icon, name, version, the update line (direct download
  only), one sentence on what it does, a card with what it keeps on this computer (the storage
  its projects and media take, of what the web view lets it keep), "Completely free and open source, under the GNU AGPL 3.0 licence. No
  ads, no account. Crash reporting is optional and off by default.", Source, Acknowledgements (third-party notices) and "Based on OpenCut".
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
- **Open With.** MagnetCut is among the apps a video opens with: MP4, M4V, MOV, MKV, WebM,
  AVI, AVCHD and 3GP (`bundle.fileAssociations`). On macOS (`tauri.macos.conf.json`) by the
  system's type for each, as a viewer ranked Alternate, and with no MIME type, from which
  Tauri would add `public.movie`, every film, those MagnetCut can't read too. On Linux
  (`tauri.linux.conf.json`) by MIME type, in its .desktop file. Not on Windows yet: Tauri's
  installer would make it the default where no app was chosen, where an OpenWithProgids entry
  is what's wanted. A video opened with it goes into the open project's media; with none open,
  as when MagnetCut starts with it, it becomes a new project of its own, named after it
  (`apps/desktop/src/opened.rs`, `apps/web/src/desktop/opened-files.ts`). On macOS from the
  open event, elsewhere from the command line, a second copy's included (the single-instance
  plugin). Tried on a Mac with a bundle of its own identifier: macOS offered it for all eight
  and not for WMV, every default stayed (VLC's, QuickTime Player's, Chrome's), a film opened
  with it closed became a project named after it, and one opened while it ran joined that
  project's media.
- **Project files open with a double click.** `.magnetcut` is MagnetCut's own: on macOS a type
  it declares (`it.salamacchine.magnetcut.project`, a kind of JSON) and owns, on Windows the
  installer's association (here being the default is right), on Linux the MIME type
  `application/x-magnetcut-project` from a shared-mime-info file the .deb and .rpm install
  (`apps/desktop/linux/magnetcut.xml`). One opened with MagnetCut opens as File, Open Project…
  opens it, a project of its own with its media found where they are, through the same code
  (`openProjectText`); opened twice, it's two projects, as Open Project… makes them.
- **Export priority.** The export panel's Priority (Normal, Low, Background), kept for the next
  export and changed while one runs, which takes it at its next frame
  (`apps/desktop/src/render/priority.rs`, `apps/web/src/export/priority.ts`). On macOS the
  export's own threads' quality of service: its thread and the AV1 encoder's, a rayon pool of its
  own that rav1e works in (the other codecs are the media engine's); on Windows the app's
  priority class, which Media Foundation's threads share. Not on Linux, where an app may lower a
  thread's priority but not raise it again, and the encoders' threads are GStreamer's.
- **Hardware-accelerated exports, said and kept to.** Each system says which codecs it encodes
  in hardware (`hardware_codecs`: VideoToolbox's list on macOS, where AV1 is rav1e's and never is;
  Media Foundation's hardware encoders on Windows; VA-API's on Linux). The export panel's
  summary, the same in Simple and Advanced, names the codec and says whether it's
  hardware-accelerated or encoded in software, and much slower. "Hardware-accelerated only", on
  by default and shown where it leaves something out, offers only the codecs in hardware: the
  smallest file is then HEVC on a Mac, not AV1 (hours for a long 4K film); the agent's export keeps
  to it too (`apps/web/src/export/hardware.ts`). Of WebM and Matroska, which the web view's
  encoders make, nothing is said: which of those are in hardware isn't known. The panel redone:
  one switch for Simple, Advanced and Fast (a mode of its own, how it copies kept while another's
  chosen); the Simple mode's destinations as cards and its questions as rows; the summary and the
  size at the foot (`apps/web/src/export/summary.ts`); the export's progress on the Export button,
  which closing the panel no longer cancels, and a failed export said where it's seen.
- **A size limit, worked back from and kept to.** The Simple mode's limit sets the rest, where the
  destination's own quality would come out over it (under it, that's kept: the limit isn't a
  target): the sound gets at most a quarter of it (AAC's 96 kbit/s at least; copied, its own
  bitrate), and the picture the largest size at which what's left carries the low quality level
  (`fitToSize`, `apps/web/src/export/wizard.ts`), down to 240p; a master file with a limit is HEVC,
  ProRes having its own rate. The summary says "854×480 to fit 100 MB". Every size limit leaves
  the encoders a margin, as VideoToolbox's HEVC and AAC ran 3% over (100 MB asked came out 102),
  and counts the file's index (12 bytes a frame), so the file comes out under it; the panel, and
  the agent's export, say when the film can't fit at all, or when a limit leaves the picture too
  little at its size (`getSizeLimitFit`, `apps/web/src/export/settings.ts`).
- **An export's end, said.** When the window isn't in front, a finished or failed export shows a
  notification and bounces the Dock icon (the taskbar button flashes on Windows): the app's own
  `show_notice` (`apps/desktop/src/notice.rs`), Notification Center's framework on macOS (only
  in a bundled .app: `cargo tauri dev`'s binary shows none), a toast on Windows and the desktop's
  notification service on Linux (notify-rust); `apps/web/src/desktop/export-notice.ts`. The
  panel's exports and the agent's both.
- **The project's details, written into its exports.** "Details", beside the project's name,
  opens a panel of what every export of the project says of itself: title, made by, date, genre,
  description, comment, camera and place (`apps/web/src/project/file-tags.ts`, kept with the
  project). Each field offers what the media library's clips say (an iPhone's: the day filmed, the
  place, the camera; `clip-tags.ts`, read with mediabunny) and takes the user's own; "Fill in from
  the clips" fills the empty ones, never the place, which is written only when chosen, with a
  warning; the export panel's summary says which details a file gets. Written by every export: in
  an MP4 as iTunes' items, the place and camera also as QuickTime's user data of old (©xyz, ©mak,
  ©mod), which ffmpeg and Android read, and the day and place as 3GPP's `date` and `loci`, which
  Apple's frameworks read (they read no camera from an MP4); by `mp4_index.rs` for every MP4 the
  desktop app writes, its own on all three systems and mediabunny's in Fast mode. In a Mac's
  QuickTime file as QuickTime's metadata, as an iPhone writes it, and its user data; the day
  written as noon in UTC, which every reader takes for that day. Matroska and WebM, through
  mediabunny, have no place or camera; a download from the browser, mediabunny's tags.
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
- **Fast mode in Export** (docs/FAST.md), asked for by users with little CPU or memory. The
  main track's clips copied out of their files without re-encoding, each from the key frame
  before its cut, as Avidemux does; or Smart Cut, which re-encodes only the frames from each
  cut to the next key frame (H.264, VP9), so clips start where they're cut. Always offered,
  with what it leaves out (transitions, effects, text, other tracks) listed before it starts.
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
- **Agents steer it through MCP** (docs/AUTOMATION.md). The open app serves MCP on
  127.0.0.1, each agent with its own token, added and revoked in Settings; Connect adds
  MagnetCut to Claude Code (a plugin, from this repository's marketplace), Codex or OpenCode in
  one click, outside the App Store edition. The editor's TypeScript does the work. Off until switched on. Any file the agent names, outside the App
  Store's sandbox; projects as `.magnetcut` files; every batch of edits one step of undo.
- **Name and marks.** OpenCut's guidelines forbid its name or logo on another product, so every
  "OpenCut" goes, logos included, except credits ("Based on OpenCut") and the licence notice.
  The Rust core is built from source as `magnetcut-wasm` (`packages/wasm`), not taken from
  upstream's `opencut-wasm` npm package.

## Order

Done: 1, 2, 3, 4, 5 (0.1.0 published on GitHub, linked from salamacchine.it), 7, 8, 10
(docs/SUBTITLES.md) and 11 (docs/HIDE.md). 12 but for trying it by hand with Claude Code and
in the App Store build (docs/AUTOMATION.md). 6 but for what's the author's in App Store
Connect: build 0.1.0 is on version 0.1.0 with its listing; the screenshots, the privacy and age
rating answers, the price and submitting it are left (docs/RELEASING.md). 9 but for a desktop of
Windows and Linux: there it's checked on CI's machines, in the app too (docs/NATIVE.md).
Some of 0.1.0 is tested in code but not yet tried in the app by hand: the native export's
panel, the subtitle editor, the native export on Windows and Linux. Hiding faces and plates
was tried in the built app, through its panel.

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
12. Agents steering it: Claude Code, Codex or any MCP client reads, edits, looks at, listens to
    and exports a project in the open app, in few tokens (docs/AUTOMATION.md has the phases).
13. Then: make it better. Fast mode in Export is done (docs/FAST.md). Next, as GitHub issues:
    audio (clip fades, solo, track meters, loudness normalisation, voice-over; #1), edits
    (freeze frame, reverse, speed ramps, slip, roll; #2), colour (chroma key, LUTs, curves,
    scopes; #3), proxies (#4) and OpenTimelineIO (#5). Each gets a plan in docs/ for the
    author to read before it's built. Built from their plans: the main track's clips converted
    to match, so Fast mode copies them, and proxies for the preview (docs/CONFORM.md); a clip's
    sound cleaned up and shaped, and the export's loudness brought to a target
    (docs/AUDIO-EFFECTS.md); voice-over, recorded or the subtitles spoken, a translation
    dubbed (docs/VOICEOVER.md); a clip's sound fading in and out, dragged at an audio clip's
    ends (docs/FADES.md).
    Planned, not yet read: several soundtracks in one file (docs/SOUNDTRACKS.md); the rest of
    the fades, the picture to black, white or transparent on any clip (docs/FADES.md).

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
- In each, the probe also runs the editor's own code (`apps/web/src/desktop/probe-checks.ts`):
  a second recorded from a stand-in tone and from a stand-in microphone, the system's voices
  (180 on macOS, 3 on the Windows runner, espeak-ng's 130 on Linux), the test films converted
  and joined (docs/CONFORM.md), and a proxy made.

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
