# Fades

`docs/PLAN.md` step 13, with issue #1 (clip fades). A clip fading in at its start and out at its
end, to black, white or transparent, its sound fading with it; set by dragging a handle at the
clip's top corners, as in other editors. Nothing is built yet.

## What's there

- Transitions (`transitions/catalog.ts`, docs/TRANSITIONS.md) are between two clips that touch
  on a video track, at the cut: Cross Dissolve, Dip to Black, Dip to White and the wipes. Their
  sound can crossfade (`crossfadeAudio`, `transitions/audio.ts`), which the preview and the
  export both apply as fade windows on each clip.
- So there's no fade at a clip's start or end on its own: the film's first shot can't come up
  from black, the last can't go to black, and a title can't fade in over a shot, short of
  keyframing its opacity and volume by hand (`opacity` and `volume` are keyframable params).
- The clip header's gradient (`hasFade` in `timeline-element.tsx`) is styling, not a fade.

## Design

### The settings
- Params on every visual and audio clip, so Properties, Undo and the agents (docs/AUTOMATION.md)
  get them as they get the others: `fadeIn` and `fadeOut` (seconds, 0 is none), `fadeInTo` and
  `fadeOutTo` (black, white or transparent) for visual clips, and `fadeSound` (on by default)
  for a video clip's sound. Not keyframable.
- The defaults for "to": black on the main track, transparent elsewhere (a title or a logo
  fading over the picture).
- A fade in and a fade out can't overlap: together they're at most the clip's length.
- At an end with a transition, the transition does the job: that end's fade isn't applied, its
  handle isn't shown, and the field says why.

### The picture
- Transparent: the clip's opacity times the fade's ramp, after its keyframed opacity
  (`resolveOpacityAtTime` in `services/renderer/resolve.ts`), so what's under it shows through:
  the tracks below, or the project's background on the main track.
- Black or white: the clip's pixels mixed toward the colour by the ramp, after its effects and
  before it's composited, its alpha kept. The same mix as Dip to Black and Dip to White's
  shader (`FadeColor`), so a fade looks like half of a dip. On an overlay that doesn't fill the
  frame, only the overlay darkens: the field says so.
- The ramp is linear in time, the same in the preview and the export (both draw through the
  same renderer).

### The sound
- The clip's gain ramped over the fade, with an equal-power curve (a linear one sounds as if it
  stops early). The preview schedules it on the clip's gain node; the export applies it in the
  mix as it applies the transitions' fade windows, the code shared.
- After the clip's effects (docs/AUDIO-EFFECTS.md), so an echo or a reverb fades out with it.

### The timeline
- On a hovered or selected clip, a small handle at each top corner. Dragged inward it sets the
  fade, snapping to frames and to the playhead, with its length shown while dragging; a ramp
  drawn over the clip shows it, over the waveform on a clip with sound. Double-clicking a
  handle removes the fade.
- In Properties, a Fade section in the clip's first tab (and in the Audio tab for audio clips):
  the two lengths, the two colours, and the sound.
- The clip's menu: Fade in, Fade out and Fade both, at a second each (or half the clip if it's
  shorter), for a quick start.

### Export's Fast mode
- A fade changes the picture: Smart Cut re-encodes only the GOPs under it (docs/FAST.md), and
  No re-encoding lists it with the other things it can't keep. A sound fade means the sound is
  mixed and encoded instead of copied (`isSoundUnchanged`).

## The phases

1. The params and the picture: transparent, black and white, in the preview and the export,
   and the Properties fields. Tests on the ramp's value at its ends and middle, and a frame
   rendered at a fade's midpoint.
2. The sound, in the preview and the export. Tests on the mix: the gain at the fade's start,
   middle and end, and with effects on.
3. The corner handles and the ramps on the timeline, and the clip's menu.
4. Fast mode: what Smart Cut re-encodes and what No re-encoding says.

## Risks

- A fade to black over a clip with its own transparency (a sticker, a title): the colour mix
  keeps the alpha, so the transparent parts stay transparent, which is what a fade to
  transparent would do there anyway.
- The handles beside the trim handles at the clip's corners: they're at the top and the trim
  handles take the full height, so the top corner is the fade's and the rest the trim's, as in
  Final Cut and Resolve.
