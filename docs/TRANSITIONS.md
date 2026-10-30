# Transitions

OpenCut never had transitions: the editor's Transitions tab is a placeholder. This is how
MagnetCut gets them, from a reading of the code (nothing built yet). `docs/PLAN.md` step 8.

## In short

The editor already composites every frame in a Rust/wgpu compositor shared by preview and
export, already has two-input GPU passes (blend, mask) to copy, keeps trims as source-time
handles and keeps undo as whole-track snapshots. The transitions themselves needn't be written:
the `gl-transitions` crate (MIT, 1.0.0) has 125 as WGSL with typed parameters and uniform
layouts, for whatever renderer brings them, which the compositor is. The work is in four places:
a two-input transition pass in the compositor, decoding two clips' frames at once (including two
halves of one file, which the decoder cache gets wrong today), audio crossfades, and keeping
transitions valid through trim, split, move, delete and speed changes. About 6 to 8 weeks of one
person to a solid first version with twelve transitions.

## What's there

### Timeline (`apps/web/src/timeline/types.ts`)
- Time is integer ticks, 120,000 a second (`rust/crates/time/src/media_time.rs`), frame-exact for
  the usual rates: "A ends where B starts" is an exact comparison.
- An element has `startTime`, `duration`, `trimStart`, `trimEnd` and an optional
  `sourceDuration`, with `trimStart + duration * rate + trimEnd == sourceDuration`
  (`timeline/group-resize/compute-resize.ts`). **The handles exist already**: A's `trimEnd` and
  B's `trimStart` are the media past the cut. Images, text and stickers have no
  `sourceDuration`, so no limit.
- Overlap on one track is refused by placement, move and resize (`timeline/placement/overlap.ts`,
  the resize controller), with half-open spans, so touching clips are fine.
- Elements aren't linked to each other, and `track.elements` isn't sorted: sort by `startTime` to
  find neighbours.
- Commands snapshot `scene.tracks` and restore it on undo; ripple shifts `startTime` from a diff
  of the tracks; one reactor runs after each command (`core/index.ts`). Anything stored **in the
  tracks** gets undo, ripple and saving for free.
- Split keeps the id on the left half and gives the right half a new one
  (`commands/timeline/element/split-elements.ts`); `retainSide: "right"` drops the original id.

### Frames (one pipeline for preview, export, snapshots and thumbnails)
- The preview's frame loop → `CanvasRenderer.render` → `resolveRenderTree`
  (`services/renderer/resolve.ts`) → `buildFrameDescriptor`
  (`services/renderer/compositor/frame-descriptor.ts`) → Rust `Compositor::render_frame*`
  (`rust/crates/compositor/src/compositor.rs`), WebGPU with a WebGL2 fallback.
- Export loops over the same renderer (`services/renderer/scene-exporter.ts`) into mediabunny;
  audio is mixed once beforehand. A transition in the compositor shows in preview and export
  alike, and in the native export of step 9, which builds the same crate.
- Per layer: transform and opacity → effects → mask → blend into the scene (`render_layer`).
  Frame items are a layer or a scene effect, each with one input.
- The blend and mask passes (`shaders/mask.wgsl`) take two inputs: the model for a transition
  pass. The effects pipeline (`rust/crates/effects/src/pipeline.rs`) takes one, with one fixed
  uniform struct: not the place.
- Elements are active on `[start, start + duration)` and invisible outside it (`resolve.ts`):
  showing handle frames means widening that.
- **The decoder cache is per media file** (`services/video-cache/service.ts`: a mediabunny
  `CanvasSink` with `poolSize: 3`, one iterator, newer requests superseding older ones,
  forward-only within 2 s, else a seek). Two files decode side by side fine; **two halves of one
  split clip, the commonest cross-dissolve, would get stale frames and seek on every frame.**
- The editor uses the Rust side through the npm package `opencut-wasm`; changing the compositor
  means building `rust/wasm` ourselves (`rust/wasm/README.md`), on the way to publishing
  `magnetcut-wasm`.

### Audio (`media/audio.ts`, `timeline/audio-state.ts`, `core/managers/audio-manager.ts`)
- No fades or crossfades anywhere. A clip's gain is `params.volume` in dB, which can be
  keyframed.
- One choke point for gain: `resolveEffectiveAudioGain` (`audio-state.ts`). Export mixes per
  sample in `mixAudioChannels`; preview plays either streamed chunks at a fixed gain or prepared
  buffers with gain automation (`shouldUsePreparedClipBuffer`).
- `fetchLibraryAudioClip` (`media/audio.ts`) passes ticks where seconds are expected. It served
  the sound library, which MagnetCut removed: probably dead code, to delete.

### Storage, interface, tests
- Projects in IndexedDB, media in OPFS, `CURRENT_PROJECT_VERSION = 31`. An **optional** new field
  on a track or element needs no migration (as `effects?` and `masks?` didn't).
- The Transitions tab is registered (`components/editor/panels/assets/assets-panel-store.tsx`)
  with a placeholder view. The Effects tab (GPU thumbnails from
  `services/renderer/effect-preview.ts`, draggable items) is the model. Drops hit-test elements
  only: hitting a cut is new.
- Selection is elements, keyframes or mask points (`selection/editor-selection.ts`); the
  inspector reads elements only.
- `bun test` runs in CI on all three systems; the Rust crates have tests only in `time` and
  `bridge`.

### gl-transitions (`crates.io/crates/gl-transitions`)
- 125 transitions as WGSL (and SkSL, Metal, GLSL ES 3.00), each with metadata, typed default
  parameters and `uniform_buffer(progress, ratio)`. MIT, but for a few under BSD (InvertedPageCurl
  and others; notices in `generated/LICENSES.md`), which ship only with their notices (step 7).
- One binding layout for all, group 0: binding 0 the uniforms (`progress`, `ratio`, then the
  transition's own), 1 the sampler, 2 from, 3 to (4 an extra texture for LumaWipe and
  DisplacementMap). Fragment `main(@location(0) uv)` with GL's bottom-left uv. Uses
  `textureSampleLevel`, which the WebGL2 fallback handles.
- The compositor's fullscreen vertex shader (`rust/crates/gpu/src/shaders/fullscreen.wgsl`) emits
  top-left uv: a variant emitting bottom-left uv runs the crate's shaders unchanged.
- Brand new: pin the version, vendor it if it moves.

## Design

### Model: on the track, using the handles
```ts
// timeline/types.ts, on VideoTrack (main and overlay video tracks)
transitions?: Transition[];

interface Transition {
  id: string;
  fromElementId: string;      // A, ending at the cut
  toElementId: string;        // B, starting at the cut
  type: string;               // a catalogue id: "fade", "directional-wipe"…
  duration: MediaTime;        // ticks, rounded to frames
  alignment: "center" | "end" | "start";   // centred on the cut, ending at it, starting at it
  params: ParamValues;        // the transition's own: direction, smoothness, colour…
  crossfadeAudio: boolean;
}
```
- Clips stay touching and nothing overlaps, so every placement, move and resize rule holds. The
  transition uses A's tail handle (`trimEnd`) and B's head handle (`trimStart`).
- On the track, not on the elements: undo, ripple and saving carry it, and copying elements
  leaves no dangling references. An optional field: no migration.
- For a cut at `c` and a duration `d`, the window is `[c - d/2, c + d/2)` centred,
  `[c - d, c)` ending at the cut, `[c, c + d)` starting at it. Centred needs `d/2` of handle on
  each side, ending needs `d` of B's head, starting `d` of A's tail (in source time: clip time ×
  rate).
- Defaults: 0.5 s, centred, audio crossfade on. Too little handle: the duration is clamped to
  what's there, and the inspector says so. (Freezing the edge frame, as other editors offer, can
  come later.)
- The timing (window, progress, each side's source time, handle checks) is a new Rust crate,
  `rust/crates/transitions`, exported like `time`: business logic in `rust/`, where the native
  pipeline can use it too.

### Rendering: one new frame item, one new pipeline
1. `scene-builder.ts`, which still knows the tracks, finds each transition's pair and emits a
   transition node owning both elements' visual nodes; within the window the two are drawn only
   through it.
2. `resolve.ts` resolves both at their handle times (A past its end, B before its start) with the
   timing crate; outside windows nothing changes.
3. `frame-descriptor.ts` emits `{ type: "transition", from, to, shader, uniforms }`, and Rust's
   frame enum (`rust/crates/compositor/src/frame.rs`) gets the same variant.
4. The compositor shares one item loop between `render_frame` and `render_frame_to_texture`. For
   a transition it renders both layers (each with its own transform, effects and mask), runs a
   new `TransitionPipeline` (the gl-transitions bindings, the bottom-left uv vertex shader,
   uniforms padded to 16 bytes for WebGL), then blends the result into the scene. Pipelines are
   compiled on first use and cached, not all 125 at start.
5. Decoding: a sink per element (`mediaId + elementId`), or a small frame cache per file keyed by
   timestamp, so two halves of one file each get their frames without seeking; and a check that
   mediabunny's canvas pool doesn't reuse a canvas still being uploaded.

### Audio crossfade
- Across the window, equal power. The gain goes in where `resolveEffectiveAudioGain`'s callers
  apply it: per sample in `mixAudioChannels` for export; in preview, clips under a transition take
  the prepared-buffer path with gain automation.
- Each such clip's audio extends into its handle for the window.

### Edits
- Commands `add-transition`, `update-transition` and `remove-transition`
  (`commands/timeline/transition/`, after `commands/timeline/element/effects/add-effect.ts`), on
  `TimelineManager` and as actions.
- A second reactor after every command drops a transition whose pair is gone or no longer touching
  and clamps its duration to the handles left (trims, speed changes). It never moves clips.
- Split: when the split element is a transition's `from`, it points to the new right half (the
  left keeps the id); `retainSide: "right"` re-points both sides. In the split command.
- Trimming A's end or B's start uses up handle, and the reactor clamps. Later: resize limits that
  keep the transition's handle.

### Interface
- Transitions tab: the catalogue as a searchable grid, each thumbnail animated by the same
  pipeline on two sample images (as `effect-preview.ts` does for effects).
- Drag one onto a cut: hitting a cut (a few pixels around the boundary of two touching clips on
  one video track) highlights it; dropping adds the transition with the defaults.
- Right-click on a cut, or a shortcut: the default cross-dissolve.
- On the timeline, a bar over the window, selectable: selection gets a `transitions` kind
  (`selection/editor-selection.ts`, the selection manager, Delete in the editor actions).
- Inspector: type, duration, alignment, the transition's parameters (from the crate's typed
  ones), audio crossfade, and a line when the duration was clamped.

### The first twelve
All MIT: Fade (cross-dissolve), FadeColor (dip to black or white), FadeGrayscale, WipeLeft,
WipeRight, WipeUp, WipeDown, DirectionalWipe, Slides, SimpleZoom, CircleOpen, DirectionalWarp.
More are a catalogue entry each afterwards.

## Phases

| Phase | What | Done when | Days |
|---|---|---|---|
| 0. Build our own wasm | Build `rust/wasm` and use it instead of `opencut-wasm`; `cargo test` in CI; frame tests (Playwright, two clips of solid colours, pixel checks) | A frame test fails, then passes | 2–3 |
| 1. Cross-dissolve | Model and timing crate, with tests; the `transition` frame item in TS and Rust; `TransitionPipeline` with Fade; scene builder and resolve at handle times; a decoder per element; an action to add one (no UI yet) | Preview and export dissolve correctly between two files **and two halves of one**: the expected pixels at 0, 0.5 and 1; no seek per frame | 8–10 |
| 2. Edits | Commands, the reactor, split, trim and speed clamping, ripple; a test per edit | Every edit keeps a valid transition or drops it, and undo brings it back | 4–5 |
| 3. Audio | Equal-power crossfade in export and preview; audio into the handles | Exported audio crossfades (sample checks); preview sounds and meters the same | 3–4 |
| 4. Interface | The tab with previews, drop on a cut, right-click and shortcut, timeline bar, selection, inspector | Someone adds, changes and removes transitions without the action | 6–8 |
| 5. The other eleven | Their parameters; WebGL2 and every system's web view; reusing upload textures (each upload makes a new one today); 4K two-stream playback | All twelve pass the frame tests on WebGPU and WebGL2; 1080p transitions play at frame rate on a mid-range laptop | 5–7 |

About 28 to 37 days; phases 3 and 4 can run side by side after phase 2.

## Risks
- **Two streams at once** (4K, or one file at two times) may not hold frame rate on weak
  machines; export is unaffected (it isn't real time). Decoders per element first, then a frame
  cache, then a preview quality setting if needed.
- **WebGL2**: every shader has to compile through naga to GLSL ES 3.00. The crate leaves out any
  its compilers reject, but both backends need testing.
- The crate is days old: pinned, and vendored if it moves.
- A preview rendered during an export shares the one compositor and its texture ids (true today;
  more visible with two inputs).
