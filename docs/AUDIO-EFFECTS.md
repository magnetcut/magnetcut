# Audio tuning

`docs/PLAN.md` step 13, beside issue #1 (clip fades, solo, track levels and meters, loudness,
voice-over). A clip's sound cleaned up and shaped: noise reduction, hum removal, a low cut, an
equaliser, a compressor, echo and reverb, with presets. It sounds the same in the preview and
in the export, and nothing leaves the computer. All four phases are built (Done, at the end).

## What's there

- The preview (`core/managers/audio-manager.ts`): each clip's decoded sound through a gain (its
  volume) into the master, and the master through the limiter (`media/audio-mastering.ts`).
- The export (`media/audio-mix.ts`): the clips mixed sample by sample, a window at a time, then
  mastered through the same limiter in an OfflineAudioContext, with a preroll so the windows
  join up.
- So the two share the limiter, not what's done to each clip: an effect on a clip needs code
  that both can run.
- `rust/crates/audio`: the time-stretch that keeps the pitch (WSOLA), in the editor through
  `magnetcut-wasm`.
- The clip's Audio tab in Properties: Volume.

## Design

### Where it runs
- In Rust, in `rust/crates/audio`: a chain of processors that keep their state from one block
  to the next. The export runs each clip through it a window at a time; the echo and reverb
  are cut at the clip's end, with a short fade, as in other editors.
- The preview runs the same chain, in an AudioWorklet running the crate's wasm. If a web view
  can't run wasm in a worklet, the clip's sound is processed ahead in a worker and kept, as the
  waveforms are, and done again when a setting changes. Phase 1 finds out which, in each web
  view.
- Not Web Audio's own nodes: they'd do in the preview, but the export doesn't mix in a Web Audio
  graph, and Web Audio's compressor and filters aren't specified exactly, so the two would
  differ.

### The processors
- Reduce noise: RNNoise's network (`nnnoiseless`, a Rust port; BSD-3-Clause, checked as the
  code's licences are). It's made for voices: steady noise (fans, air, traffic, hiss) taken
  out, in real time on any CPU. It works at 48 kHz, so other rates are resampled to it and back.
  A strength, mixing in the original. On music it does harm, and the tab says so.
- Remove hum: notches at 50 or 60 Hz and their harmonics, picked or found in the clip's
  spectrum.
- Low cut: a high-pass at 80 Hz for rumble, wind and handling, adjustable.
- Equaliser: a low shelf, three peaks and a high shelf (biquads, from the Audio EQ Cookbook),
  each with its gain and frequency, the peaks with their width; the curve drawn over the
  frequencies.
- Compressor: threshold, ratio, attack, release and makeup gain, with a meter of the gain taken
  off.
- Echo: delay, feedback and mix.
- Reverb: Freeverb (public domain): room size, damping, width and mix.
- Always in that order: noise, hum, low cut, equaliser, compressor, echo, reverb; each one on or
  off.

### Interface
- In the clip's Audio tab, below Volume: Clean up (Reduce noise, Remove hum, Low cut), then
  Equaliser, Compressor, Echo and Reverb, each a section that turns on.
- Presets above them: Voice (noise, low cut, gentle compression, a lift where voices are
  clearest), Podcast, Phone call, Hall, and Off.
- With several clips selected, set on all of them. On audio clips and on video clips with sound
  alike. Keyframes on these later, not now.
- Agents (docs/AUTOMATION.md): the settings are clip parameters, so an MCP client sets them as
  it sets the volume.

## The phases

1. The chain in the crate, with the low cut, the equaliser and the compressor, tested on made-up
   signals: a sine's level through each filter at known frequencies, the compressor's gain on a
   step. The preview's way decided in WKWebView, WebView2 and WebKitGTK (the probe), and the
   export through the chain.
2. Reduce noise and Remove hum, tested on noise mixed into speech: the noise's level down, the
   speech's kept.
3. Echo and reverb, the presets and the curve.
4. With issue #1: loudness normalisation, measured after this chain.

## Risks

- RNNoise is for speech. For music and other sounds, a spectral gate could follow if it's
  asked for.
- The preview on a weak computer runs the chain for every clip that's playing. Processing ahead
  (above) is the fallback, and it leaves the CPU free during playback.

## Done

- The chain is `rust/crates/audio` (`settings`, `chain`, `biquad`, `compressor`, `echo`,
  `reverb`, `resample`, `denoise`), in the editor as `AudioEffectsChain` from `magnetcut-wasm`
  (`rust/wasm/src/audio.rs`): the settings in, blocks of samples through, its latency told.
  Tested in `tests.rs` on made-up signals: each filter's level at known frequencies, hum out and
  the rest kept, the compressor's ratio and its linked channels, the echo at its delay, the
  reverb dying away, blocks matching the whole, any channel count, and the noise reduction
  lined up at any rate.
- Where it runs: neither a worklet nor a worker. Both the preview and the export already have a
  path that works on a clip's whole sound (the one a retimed clip takes): the preview's prepared
  buffer (`audio-manager.ts`) and the export's whole-clip sound (`audio-mix.ts`). A clip with
  effects goes that way, through `applyAudioEffectsToBuffer` (`media/audio-effects.ts`), a
  second at a time with the page given a turn between. So the two sound the same by
  construction, there's nothing to probe in each web view, and playback costs nothing extra.
  The cost: a change to a setting works out the clip again before it plays (a moment for a long
  clip; the tab says so).
- The chain's latency (RNNoise's frame, the resampler) is taken out, so the sound stays lined up
  with the picture; echo and reverb are cut at the clip's end with a 20 ms fade.
- Remove hum is picked (50 or 60 Hz), not found in the spectrum: notches at the frequency and
  its harmonics up to the fifth.
- The settings are clip parameters (`AUDIO_EFFECT_PARAMS`), not keyframable, and left unset on
  new clips: a clip with none set plays its sound as it is (`readAudioEffects` gives null), and
  Fast mode's sound copy (docs/CONFORM.md) and Export's copy of the source's sound
  (`findPassthroughClip`, which used to copy a lone clip's sound without its effects) only
  take a clip with none.
- The Audio tab (`audio-effects-tab.tsx`, its controls in `audio-controls.tsx`): Volume, the
  presets (Off, Voice, Podcast, Phone call, Hall; each sets every setting, Off clears them),
  then a section each, its switch in the header. The numbers are bars filled to their value
  (from zero where the range spans it, on a log scale where it spans more than twentyfold:
  attack, release, delay, ratio, frequency, width), dragged sideways, Shift for finer, the
  arrow keys a step, a double-click back to the default; Remove hum is three buttons. The
  equaliser is drawn (`media/eq-curve.ts`, the same cookbook formulas at 48 kHz), 20 Hz to
  20 kHz and ±24 dB, its five bands points dragged on it (Shift holds the frequency), the wheel
  on a mid one for its width, a double-click to flatten one; under it the chosen band's bars.
  Drawn when off too, and a point dragged turns it on. The compressor's curve beside its
  threshold, ratio and makeup. A drag is held in the tab and written when let go: one undo
  step, and the clip's sound worked out once.
- Tested in the editor (`media/__tests__/audio-effects.test.ts`): settings read, presets, the
  low cut through the real chain, the noise reduction lined up, and the curve. Checked in
  Chrome: the presets, playback, and Phone call in an export (220 Hz down 9 dB from the clip).
- Phase 4, loudness (`rust/crates/audio/src/loudness.rs`, `LoudnessMeter` in `magnetcut-wasm`):
  ITU-R BS.1770-4 integrated loudness as EBU R128 measures it (K-weighting worked out for any
  sample rate, 400 ms blocks overlapping by 75%, gated at -70 LUFS and 10 LU under); it also
  reads the true peak (the standard's 4 times oversampling) and the loudness range, unused yet.
  Tested on EBU Tech 3341 and 3342's signals, within 0.1. Export's Audio section has Loudness:
  As it is, Streaming (-14 LUFS), Podcasts (-16) or Broadcast (-23); Simple's "YouTube, TikTok,
  Instagram" aims at -14. The mix
  (`mixTimelineAudio`) is then made twice: once to measure it, after each clip's effects and
  before the limiter, and once for the file, turned up or down by the difference (20 dB at
  most), the limiter keeping peaks under -1 dB, so a mix brought up a lot comes out a little
  under its target. A target means the source's sound isn't copied, in Fast mode too. Checked
  in Chrome: an export at -14 read -13.6 LUFS in ffmpeg's `ebur128`, the same mix left as it is
  -6.9. Through the desktop's native export as well: the agent check
  (`apps/desktop/scripts/agent-check.ts`, in the probe) exports its -20 LUFS tone for sites and
  hears it back within 1 LU of -14; on a Mac, an HEVC MP4 that ffmpeg reads at -13.6. On
  GitHub it heard -13.3 on macOS and Linux (HEVC) and -13.2 on Windows (H.264). Tests:
  `export/__tests__/loudness.test.ts` (the meter through wasm, the gain, the choices and
  Simple's target).
- Not done: the compressor's meter, setting several selected clips at once, keyframes, and
  showing the measured loudness before exporting.
- RNNoise does little for broadband hiss or white noise: it's made for the noise of rooms,
  fans and traffic around a voice. A spectral gate could follow if hiss is what's asked for.
