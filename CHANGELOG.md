# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added
- Export settings, as in HandBrake: MP4, MOV, MKV or WebM; H.264, HEVC, VP9 or AV1, whichever
  your computer can encode; quality as a level, a bitrate or a file size to fit in; a smaller
  size (4K down to 480p) and another frame rate; and the sound's codec, bitrate and stereo or
  mono. The panel says what it will make and about how big before it starts.
- Export presets: a few built in (Fast 1080p, Fits in 25 MB, Web 1080p and others) and your
  own. Export remembers the settings you used last.
- Crop on export, with Find black bars to take off letterboxing, and a size of your own.
- Export copies a film's sound as it is, without re-encoding it, when the timeline plays that
  sound uncut and the container takes its codec (on by default; Audio in the export panel).

### Changed
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
