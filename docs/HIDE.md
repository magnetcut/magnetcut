# Hiding faces and plates

`docs/PLAN.md` step 11: blurring a child's face, pixelating or blacking out a car's plate, as
the region moves through the shot, by hand, tracked, or found by itself. Nothing leaves the
computer. What's built is under Done.

## What was there

From OpenCut: a Blur effect; masks (rectangle, ellipse, star and others, freeform) on video,
image and graphic clips, moved and sized with handles in the preview, feathered; adjustment
layers (effects on an effect track, applied to everything beneath); keyframes on clips'
transforms and on effects' and graphics' parameters. Not there: a mask on an adjustment layer,
so an effect over part of the picture only; keyframes on a mask, so a mask that follows what
moves.

## The phases

### 1. A Hide region
- An adjustment layer with a mask: its effect applied to what's beneath, cut by the mask and
  laid over the picture, so only what's inside changes (the compositor's scene effect, given a
  mask as a layer is).
- Three looks: Blur, Pixelate (the size of the blocks), and Cover (a solid colour, black by
  default). In the Adjustment tab's Hide section; dropped on the timeline above the clip, with
  an ellipse for a face or a rectangle for a plate in the middle of the picture, moved and sized
  in the preview with the mask's handles.
- Masks keyframed: position, size, rotation and feather, on any clip's mask as on a Hide
  region's, with the keyframe buttons the other parameters have.
- In both exports, the web view's and the native one: the mask is one of the editor's drawings,
  uploaded as a texture.

### 2. Tracking
- Track, in the region's properties: from the frame showing, what's inside the region followed
  frame by frame to the region's end, and back to its start; a keyframe for each frame, thinned
  where the motion is straight, each one editable.
- On decoded frames at a small size, in a worker: the region's picture matched around where it
  was (normalised cross-correlation), at a few scales; the template renewed while the match is
  sure, and the tracking stopped, saying where, once it isn't.
- In Rust (`rust/crates/tracking`), reaching the editor as `magnetcut-wasm`.

### 3. Finding faces and plates
- Find faces and Find plates: a detection model, downloaded once when it's first used (from
  Hugging Face, as Whisper's models are), run on the computer. Each face or plate found becomes a
  Hide region, followed by phase 2's tracker between detections, the same one joined across
  frames.
- The models: small ones, with licences MagnetCut can download and use (checked as the code's
  are), chosen when this phase starts.
- The network: one download for each model, when it's first used; nothing uploaded. CLAUDE.md
  lists it with the others.

## Risks
- A frame the region misses shows the face: tracking and detection help, they don't promise.
  The panel says to check the result, and both exports hide exactly what the preview shows.

## Done
- Phase 1. A scene effect with a mask in the compositor: checked on the GPU, a cover over half
  the picture leaving the other half as it was, and pixelation in blocks of one colour. Scene
  effects are now read as the editor sends them: before, their fields weren't camelCased, and
  every adjustment layer was refused. The Hide section adds a region, its mask keyframed by the
  toggle in its Masks tab or by dragging it where it has keyframes; tested in code (a mask
  keyframed in two places moves between them; an adjustment layer's mask is a keyframe target),
  not yet tried in the app.
- Phase 2. The tracker (`rust/crates/tracking`): a square with a pattern of its own, moving two
  pixels a frame across noise and growing, followed for 30 frames within 0.1 px and its size
  within a pixel; a square gone, lost rather than guessed. In the editor (`hide/track.ts`), the
  Masks tab's Track: the timeline rendered without its Hide regions, at 640 px at most, from the
  playhead to the region's end and back to its start, a keyframe of the mask's place and size
  on every frame found, in one change; where it's lost, it says when. Followed through the
  editor's WebAssembly in its tests; not yet tried in the app.
- Phase 3. Find faces and Find plates, in the Hide section, over the selected clip's span or the
  whole timeline: YuNet for faces (OpenCV's, MIT, 233 KB) and a YOLOv11n fine-tuned on plates
  (AGPL-3.0, 10.5 MB), each downloaded once from Hugging Face at a pinned revision, checked by
  its SHA-256 and kept in the web view's cache, run by ONNX Runtime Web (the copy the app ships;
  WebGPU, or WebAssembly where there's none) in its own worker. Every tenth frame is searched; a
  find is matched to the region it overlaps, which it moves back onto what it found, or starts
  one; between searches the tracker follows each region, and three searches without it end it.
  Each one followed for five frames or more becomes a Hide region, a little bigger than what was
  found, keyframed on every frame. In the built app, in Chrome: 47 faces in a group photo, in
  44 ms once the model is loaded; the decoding of both models' outputs tested in code. Not yet
  tried on a film in the app.
