# MagnetCut

A video editor for macOS, Windows and Linux that keeps everything on your computer. Free and
open source: no account, no ads, no telemetry.

> **Early days.** The first release is next, and the Mac App Store edition is in testing
> (TestFlight). Until then the desktop app runs from source. [docs/PLAN.md](docs/PLAN.md) has
> the decisions and the order.

## What it does

- A timeline for video, audio, images, text and stickers, with effects, masks, keyframes, speed
  changes and colour adjustments (exposure, contrast, saturation, vignette and more).
- Transitions between clips (dissolves, dips, wipes, slides, zooms), with audio crossfades.
- Export that does HandBrake's job: MP4, MOV, MKV or WebM in H.264, HEVC, VP9 or AV1 (and
  ProRes on a Mac); quality as a level, a bitrate or a file size to fit in; size presets, crop
  with the black bars found for you, frame rate; deinterlace, denoise and sharpen; presets of
  your own. A Simple mode asks in everyday words. On a Mac it decodes, draws and encodes on the
  GPU, with the system's own encoders.
- A subtitle editor: SRT, WebVTT, ASS, SSA, SubViewer and MicroDVD, in any text encoding;
  synced to the speech in one click, or timed as you type while it plays; burned into the
  picture or embedded as a track on export.
- Captions from speech, transcribed on your computer (Whisper).
- Media is read where it is on your disk, not copied, so a file of any size goes in.

Planned:

- Signed releases for macOS, Windows and Linux, which update themselves, and the Mac App Store
  edition.
- Export natively on the GPU on Windows and Linux too, as it does on a Mac.

## Privacy

Your projects and media stay on your computer. MagnetCut has no servers and sends nothing about
you anywhere. It goes online only when you use something that needs a download: a font from
Google Fonts, a transcription model from Hugging Face and the code that runs it from jsDelivr
(once), the platform logos in the safe-area guides.

The desktop app also checks once a day whether there's a new version, by downloading a small file
from GitHub; Settings turns that off. An update installs only when you say so, and only if it's
signed with MagnetCut's key.

## Run it from source

You need [Bun](https://bun.sh), and [Rust](https://rustup.rs) with the WebAssembly target and
wasm-pack: the editor's core is Rust (below).

```sh
rustup target add wasm32-unknown-unknown && cargo install wasm-pack   # once
bun install
bun run build:wasm # the Rust core, as WebAssembly (bun dev:web and build:web do it too)
bun dev:web        # the editor at http://localhost:3000
bun test
bun run build:web  # the static app, in apps/web/out
```

The desktop app also needs the Tauri CLI (`cargo install tauri-cli`):

```sh
cd apps/desktop
cargo tauri dev     # the editor in a window, reloading as you edit
cargo tauri build   # the installers, in target/release/bundle
```

After adding or updating a dependency, `bun run licenses` checks that its licence can ship and
updates the notices in About (`apps/web/public/acknowledgements.txt`); CI checks it too.

Releases are made as [docs/RELEASING.md](docs/RELEASING.md) says.

### The Rust core

`rust/` holds the platform-independent core (GPU compositor, effects, masks, time). The web app
uses it as WebAssembly: `rust/wasm` exports it, and `packages/wasm` (the `magnetcut-wasm`
package) builds it with wasm-pack, which Turborepo runs before the web app's dev server and build
whenever `rust/` changed. While you edit it, `bun dev:wasm` (with `cargo install cargo-watch`)
rebuilds on every change.

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Licence

MagnetCut is licensed under the [GNU AGPL 3.0](LICENSE).

It's based on [OpenCut](https://github.com/OpenCut-app/opencut-classic), copyright 2025-2026
OpenCut, under the MIT licence ([licenses/OpenCut.txt](licenses/OpenCut.txt)). MagnetCut isn't made,
sponsored or endorsed by OpenCut.
