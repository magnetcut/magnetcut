# MagnetCut

A video editor for macOS, Windows and Linux that keeps everything on your computer. Free and
open source: no account, no ads, no telemetry.

> **Early days.** MagnetCut is being built. Today the editor runs in a browser; the desktop app
> is next. [docs/PLAN.md](docs/PLAN.md) has the decisions and the order.

## What it does

Today, from OpenCut:

- A timeline for video, audio, images, text and stickers, with effects, masks, keyframes and
  speed changes.
- Captions from speech, transcribed on your computer (Whisper).
- Export to MP4 or WebM.

Planned:

- The desktop app (Tauri), signed and updating itself, and a Mac App Store edition.
- HandBrake's export settings: formats and codecs, size presets, quality, frame rate, and
  subtitles embedded as a track or burned in.
- A subtitle editor, with subtitles synced to the speech in one click.
- GPU from decoding to encoding.

## Privacy

Your projects and media stay on your computer, in the app's own storage. MagnetCut has no
servers and sends nothing about you anywhere. It goes online only when you use something that
needs a download: a font from Google Fonts, a transcription model from Hugging Face (once), the
platform logos in the safe-area guides.

## Run it from source

You need [Bun](https://bun.sh).

```sh
bun install
bun dev:web        # the editor at http://localhost:3000
bun test
bun run build:web  # the static app, in apps/web/out
```

The desktop app needs [Rust](https://rustup.rs) and the Tauri CLI (`cargo install tauri-cli`):

```sh
cd apps/desktop
cargo tauri dev     # the editor in a window, reloading as you edit
cargo tauri build   # the installers, in target/release/bundle
```

### The Rust core

`rust/` holds the platform-independent core (GPU compositor, effects, masks, time), which the
web app uses as WebAssembly through the published `opencut-wasm` package. Only if you're editing
`rust/wasm`, build it and link it instead:

```sh
cargo install wasm-pack cargo-watch   # once
bun run build:wasm
cd rust/wasm/pkg && bun link
cd ../../../apps/web && bun link opencut-wasm
bun dev:wasm                          # rebuilds on changes
```

`bun add opencut-wasm` in `apps/web` goes back to the published package.

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Licence

MagnetCut is licensed under the [GNU AGPL 3.0](LICENSE).

It's based on [OpenCut](https://github.com/OpenCut-app/opencut-classic), copyright 2025-2026
OpenCut, under the MIT licence ([licenses/OpenCut.txt](licenses/OpenCut.txt)). MagnetCut isn't made,
sponsored or endorsed by OpenCut.
