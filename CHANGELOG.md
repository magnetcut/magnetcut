# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

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
