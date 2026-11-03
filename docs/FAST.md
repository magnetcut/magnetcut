# Fast mode

Export's Fast mode is for computers with little CPU or memory, and for keeping the original
quality: the main track's video clips are copied out of their files, one after another, as
Avidemux does, instead of each frame being drawn and encoded again. It's always there, beside
Off; the panel lists what the timeline has that won't be in the file, before it starts. The
code is in `apps/web/src/export/fast`.

## The two options

- **No re-encoding.** Nothing is decoded or encoded. A clip can start only on a key frame, so
  each one starts at the key frame at or before its cut, up to a group of pictures early (often
  a second or two). At a clip's end the copy stops at the first frame shown at or past the cut,
  which keeps every frame copied decodable: up to the B-frames before that (one to three
  frames) is lost.
- **Smart Cut.** The frames from the cut to the next key frame are decoded and encoded again,
  and so are the few frames that the copy leaves at the end, so a clip starts and ends where
  it's cut. The rest is copied. A clip with no key frame in it is encoded whole. Only H.264 and
  VP9 in 8-bit 4:2:0 (all the web views' encoders take); anything else falls back to No
  re-encoding, and the panel says so.

## What's left out

Transitions, pictures, effects and masks, speed changes, position, size and opacity changes,
text and subtitles, stickers and graphics, effect layers, the other video tracks and the audio
tracks. Gaps between clips are closed up. A clip's volume is kept: then its sound is mixed and
encoded rather than copied.

## How a file is made

- `clips.ts`: the main track's visible video clips, in order, and where each is cut in its
  file; what's left out, for the panel.
- `cuts.ts`: where a clip is cut. Packets go in decode order from a key frame; those shown
  before it (an open GOP's leading frames, which need the frames before the key) are skipped;
  the copy stops at the first packet shown at or past the end. In H.264 a cut starts only at an
  IDR frame, where the decoder starts afresh.
- `exporter.ts`: each file opened once (mediabunny); the clips joined if their files can be
  (the same codec, size and rotation, in a container that takes it); the packets written with
  their times moved to where the clip goes. The MP4 and MOV files keep the sources' timescale
  when they share one. The output is written as it's made, to the file picked in the desktop
  app.
- The sound is copied when every clip's is the same codec and settings, unchanged, in a
  container that takes it: each clip from the packet that keeps it within half a packet of its
  picture, so the sound never drifts. Otherwise the clips' sound is mixed (`mixTimelineAudio`
  over a timeline of the clips as laid out) and encoded with Advanced's audio settings.

## Joining H.264 with different settings

An MP4 track has one decoder configuration (avcC), and every frame must decode with it. Files
made by different cameras, and the frames Smart Cut encodes, have their own parameter sets. The
avcC can hold several, so `h264.ts` gives each source's SPS and PPS ids that no other uses,
puts them all in the one avcC, and rewrites each frame's slices to point at its own (the
`pps_id` in the slice header). That's the standard's own mechanism: every decoder has them all
from the start, and nothing changes in the stream.

Rewriting a slice changes the length of one Exp-Golomb code at its start. In CAVLC the rest of
the slice follows bit for bit, shifted (`bits.ts`). In CABAC the slice data starts on a byte:
the whole header is parsed (reference list changes, weighted prediction tables, reference
marking) to find its end, then aligned with one bits and the data copied as it was. Emulation
prevention bytes are taken out before and put back after.

The encoder's parameter sets are known only once it has encoded a frame, and they follow the
frames' colour space, so before the avcC is written, a frame of each source is encoded and
thrown away; each encoded packet carries the parameter sets it was made under.

## The web views

- WebKit's H.264 encoder makes only Baseline (CAVLC), and its frames join the High-profile ones
  of the files as above.
- WebKit decodes limited-range video into full-range frames, and its encoder writes the samples
  as they come, under the range the frame is tagged with. Smart Cut moves them back into the
  source's range and tags them with the source's colour space; otherwise QuickTime, which takes
  the range of the file's first parameter set, shows the copied or the re-encoded frames washed
  out.
- Checked in Chrome and in WKWebView, in MP4, MOV and MKV: the files decode in ffmpeg and
  VideoToolbox with the same frames, the copied frames exactly the source's, the re-encoded ones
  at 39 to 55 dB PSNR, for limited and full range sources, and for High (CABAC, B-frames,
  weighted prediction) joined with Baseline (CAVLC) and Main.

## Limits

- Smart Cut doesn't re-encode HEVC, AV1 or VP8 (the bitstream rewriting is H.264's, and VP9
  needs none), nor 10-bit or 4:2:2 video, nor H.264 that isn't in an MP4, MOV or MKV.
- Clips from files whose colour ranges differ: each frame says its own range, which ffmpeg,
  VLC and mpv follow; QuickTime shows the ones that differ from the first file's wrong.
- Only the main track's clips are copied, with their own sound.
