# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added
- On Windows and Linux, Export makes MP4 films in H.264 or HEVC with the computer's own
  decoders and encoders (Media Foundation; GStreamer), drawing each frame on the GPU as it does
  on a Mac, instead of in the editor, wherever the sources are files on disk. On Windows and
  Linux, as on a Mac, the computer doesn't go to sleep while it exports. On Windows and
  Linux, as on a Mac, a clip's sound is copied as it is when the timeline plays it uncut, and
  subtitle tracks go in as timed text, which players show.
- Export has a Simple mode, open by default, that asks in everyday words where the film will
  be watched (any player, old TVs too; YouTube, TikTok and Instagram; the smallest file; a master
  file to keep or edit), how big the file may be, how sharp and smooth, and the sound, and picks
  the settings from that: H.264 only where old players need it, HEVC for uploads at the bitrate
  YouTube asks for, AV1 for the smallest, ProRes for a master on a Mac. Advanced is every
  setting, as before. Nothing is ever made bigger than it was made.
- The Adjustment tab: Color (exposure, contrast, highlights, shadows, saturation, vibrance,
  temperature, tint and hue), Vignette and Sharpen. Drop one on a clip to adjust it, or add it
  to the timeline to adjust everything beneath it; its sliders are in the properties panel.
- Export settings, as in HandBrake: MP4, MOV, MKV or WebM; H.264, HEVC, VP9 or AV1, whichever
  your computer can encode; quality as a level, a bitrate or a file size to fit in; a smaller
  size (4K down to 480p) and another frame rate; and the sound's codec, bitrate and stereo or
  mono. The panel says what it will make and about how big before it starts.
- Export presets: a few built in (Fast 1080p, Fits in 25 MB, Web 1080p and others) and your
  own. Export remembers the settings you used last.
- Crop on export, with Find black bars to take off letterboxing, and a size of your own.
- On a Mac, Export makes ProRes 422 and 422 HQ in QuickTime files, AV1 in MP4 (in software,
  slower than real time), and on Apple silicon keeps a constant quality in H.264 and HEVC
  (Quality, Constant) instead of aiming at a bitrate.
- A subtitle editor in the Captions panel: a subtitle track's lines listed with how fast they ask
  to be read, edited in place; shifted, converted from one frame rate to another, lined up with
  the speech in one click or synced on two lines, overlaps and durations fixed, and saved as
  SRT, WebVTT, ASS, SSA, SubViewer or MicroDVD. Paste a script and it's timed to the speech;
  type lines as it plays; snap them to speech and cuts; translate side by side.
- Export puts subtitles in the picture, in a track a player turns on and off, or both: as
  timed text Apple's players show in MP4 and MOV from the Mac's own export, WebVTT otherwise.
- Subtitle import opens WebVTT, SSA, SubViewer and MicroDVD files as well as SRT and ASS, in
  any text encoding (older files are often in a Windows code page).
- Export filters, as in HandBrake: deinterlace, denoise and sharpen. On a Mac, HDR footage is
  tone mapped to SDR as it's exported, instead of coming out flat and grey.
- Export copies a film's sound as it is, without re-encoding it, when the timeline plays that
  sound uncut and the container takes its codec (on by default; Audio in the export panel).

### Changed
- On macOS, Export decodes, draws and encodes natively, on the GPU with the Mac's own encoders,
  when the film is MP4 or MOV in H.264 or HEVC from files on disk. H.264 comes out in the High
  profile, which looks better for its size than the Baseline the web view's encoder makes.
- The desktop app reads imported media where it is on your computer instead of copying it into
  its own storage, so a file of any size can go in (on Linux that storage held 1 GB). That's
  files picked with Import, and on macOS files dropped on the window; a file moved or renamed
  is still found. If one is gone when a project opens, MagnetCut says which.
- Export in the desktop app asks where to save, starting in your footage's folder, and writes
  the file as it's made instead of keeping the whole film in memory first. When it's done, Show
  in Finder (or Explorer, or the file manager) takes you to it.
- Export mixes the sound as it goes, a few seconds at a time, instead of decoding every file
  whole first, so a long film's soundtrack no longer has to fit in memory. It also goes through
  the same limiter as playback, so it sounds as it did in the editor. The timeline's waveforms
  are read the same way, a piece at a time.

### Fixed
- Exporting to MP4 on macOS stopped after a few frames and never finished. MP4 from the macOS
  app is now H.264 in its Baseline profile, the one the system's web view encodes properly.
- A video dropped on the editor outside the assets panel and the timeline opened in the
  editor's place, as in a browser. It's now imported, wherever it's dropped, and nothing
  dropped on the window can replace the app.

## [0.1.0] - 2026-10-30

The first version: OpenCut's editor as a desktop app for macOS, Windows and Linux, with no
account, ads or telemetry.

### Added
- The desktop app, signed and notarized on macOS, with installers for Windows (NSIS, MSI) and
  Linux (deb, rpm).
- Updates: a check once a day, which can be turned off in Settings, and Check Now in Settings,
  About and the macOS menu. An update is installed only if it's signed with MagnetCut's key, and
  only when you say so; your project is saved first.
- About MagnetCut and Settings (appearance, updates), from the menu under the logo.
- Transitions between clips on a video track: Cross Dissolve, Dip to Black, Dip to White,
  Grayscale Dissolve, four wipes, Soft Wipe, Warp Wipe, Iris, Zoom, Shrink and Grow, in a
  Transitions tab that plays each on hover. Drag one onto a cut, press T for the cut nearest the
  playhead, or right-click a clip. Each has a duration, a position (before, centered on or after
  the cut), its own settings, and a crossfade of the clips' audio.

### Changed
- Speed changes that keep the pitch use a time-stretch of MagnetCut's own, in Rust, in place of
  soundtouchjs.
- Linux: the app turns on the WebKitGTK features it needs to keep projects, and importing a
  video it can't decode says which GStreamer packages to install.

### Removed
- From OpenCut: accounts, the website, analytics, the bot check, the feedback form and the sound
  library, which needed its servers.

[0.1.0]: https://github.com/magnetcut/magnetcut/releases/tag/v0.1.0
