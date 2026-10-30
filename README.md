# MagnetCut

A video editor for macOS, Windows and Linux that keeps everything on your computer. Free and
open source: no account, no ads, no telemetry.

> **Early days.** MagnetCut is being built: the desktop app runs from source, and the first
> release is next. [docs/PLAN.md](docs/PLAN.md) has the decisions and the order.

## What it does

Today, from OpenCut:

- A timeline for video, audio, images, text and stickers, with effects, masks, keyframes and
  speed changes.
- Captions from speech, transcribed on your computer (Whisper).
- Export to MP4 or WebM.

Planned:

- Signed releases for macOS, Windows and Linux, which update themselves, and a Mac App Store
  edition.
- Transitions between clips (dissolves, dips, wipes, slides, zooms), with audio crossfades.
- HandBrake's export settings: formats and codecs, size presets, quality, frame rate, and
  subtitles embedded as a track or burned in.
- A subtitle editor, with subtitles synced to the speech in one click.
- GPU from decoding to encoding.

## Privacy

Your projects and media stay on your computer, in the app's own storage. MagnetCut has no
servers and sends nothing about you anywhere. It goes online only when you use something that
needs a download: a font from Google Fonts, a transcription model from Hugging Face (once), the
platform logos in the safe-area guides.

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
