# magnetcut-wasm

The editor's Rust side (`rust/crates/`: compositor, effects, masks, time) exported to the web app
as WebAssembly. `packages/wasm` builds it into `packages/wasm/pkg` with wasm-pack, as the
`magnetcut-wasm` package that `apps/web` imports:

```sh
bun run build:wasm   # from the repository's root; dev:web and build:web run it when rust/ changed
bun dev:wasm         # rebuilds on every change (cargo install cargo-watch)
```

Upstream published this as `opencut-wasm` on npm; MagnetCut builds it from source instead.
