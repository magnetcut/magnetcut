# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

The first version: OpenCut's editor as a desktop app for macOS, Windows and Linux, with no
account, ads or telemetry.

### Added
- The desktop app, signed and notarized on macOS, with installers for Windows (NSIS, MSI) and
  Linux (AppImage, deb, rpm).
- Updates: a check once a day, which can be turned off in Settings, and Check Now in Settings,
  About and the macOS menu. An update is installed only if it's signed with MagnetCut's key, and
  only when you say so; your project is saved first.
- About MagnetCut and Settings (appearance, updates), from the menu under the logo.

### Removed
- From OpenCut: accounts, the website, analytics, the bot check, the feedback form and the sound
  library, which needed its servers.
