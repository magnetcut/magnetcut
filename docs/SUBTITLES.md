# Subtitles

`docs/PLAN.md` step 10: a subtitle editor like Jubler's, synced as easily as in YouTube's
editor. None of Jubler's code (GPL): the parsers, retiming and alignment are written anew in
`rust/crates/subtitles`, and reach the editor as `magnetcut-wasm`. What's built is under Done.

## What was there

From OpenCut: SRT and ASS parsed in TypeScript (`apps/web/src/subtitles`) and placed on the
timeline as text elements, one per line, with ASS styles mapped to the text's; and captions
made by Whisper, which runs on the computer (`apps/web/src/transcription`).

## The phases

### 1. The core
- One model for a file's lines: start and end in seconds, the text with only `<i>`, `<b>` and
  `<u>` (each format has a way to say those), an ASS style by name; an ASS file's header and
  styles kept to write it back as it was.
- Read and written: SRT, WebVTT, ASS and SSA, SubViewer 2.0, MicroDVD (frames: its first line's
  rate, or one given). The format found by what's in the file, then its name; the text encoding
  by its byte order mark, then UTF-8, then Mozilla's detector (chardetng, encoding_rs).
- Retiming: shift, another frame rate, two-point sync (two lines' times as they are and as they
  should be), overlaps fixed, lines too brief or too long to read fixed (Netflix's rules by
  default), split, join, snapping a time to the nearest edge in reach.
- Syncing to the speech:
  - Auto-sync: lines of text timed to the words Whisper heard. Both sides as words, anchored on
    runs of three found once in each (the longest run of them in order), aligned word by word
    between anchors; each line from its first word heard to its last, one none of whose words
    were heard placed between its neighbours.
  - Offset and drift: subtitles lined up with when someone speaks, which works for a
    translation too. Every ratio of two common frame rates tried as a scale, each with the best
    shift over two minutes either way; then the shift for each half, for what drift is left.

### 2. Opening any of them
- The import opens every format, in any encoding, through the core; the captions as before.

### 3. The subtitle track and the list
- A subtitle track on the timeline, over the waveform, and beside it the list: start, end,
  duration, reading speed, text, editable in place.

### 4. Syncing, in the editor
- Paste text and it's timed to the speech (Whisper's word timestamps).
- Fix early, late or drifting subtitles in one click, or by marking two lines.
- Type while it plays: a line starts where you start typing, the video pausing if you like; or
  hold a key while a line is spoken.
- Edges snap to where speech starts and ends and to cuts.

### 5. Retiming and the rest
- Shift, stretch, frame rate, overlaps, durations, split, join; translation side by side with
  the original.

### 6. Saving and exporting
- Save as any of the formats.
- Export: soft tracks (MP4 mov_text, MKV SRT or ASS, WebM WebVTT), or burned in.

## Done
- Phase 1, with the core's tests: each format read and written back with times, lines and
  italics kept; an old encoding read; auto-sync through misheard words and a line not heard,
  and on 3000 words with some dropped and changed; 4% drift and 3.2 s late found to within
  0.15 s across half an hour; a translation, two spoken stretches a line, found 2.5 s early.
- Phase 2: the import offers .srt, .vtt, .ass, .ssa and .sub, and maps ASS styles as before
  (tested in `bun test`); a line in italics or bold throughout keeps it, partly styled ones are
  said to be left plain. Not yet tried in the app.
- Phases 3 to 6 in part, in the Captions panel (`subtitles/components/subtitle-list.tsx`), not
  yet tried in the app; the logic behind them tested in `bun test` (`subtitles/track.ts`,
  `subtitles/sync.ts`):
  - A text track can be one of subtitles (`subtitles` on it, set by the import and by Whisper's
    captions), with a captions icon in the timeline. Its lines listed with when they start and
    how fast they ask to be read, the one showing marked; a line clicked moves the playhead to
    it and opens its start, end and text to edit.
  - Lined up with the speech in one click: the timeline's sound mixed down to 16 kHz, speech
    found by its loudness (`speech_spans`: 12 dB above its quiet, music counting too), and the
    core's fit applied. Two-point sync: "Spoken now" on two lines, then sync on them. A script
    pasted in, timed to Whisper's segments (their words spread over each by length, until
    Whisper gives words).
  - Shift, another frame rate, overlaps and durations fixed; saved as any of the six formats
    (in the desktop app through its save dialog).
  - Export puts the subtitle tracks in the picture (as before), in tracks a player turns on and
    off, or both (`export/subtitles.ts`): each a WebVTT track, through mediabunny, in MP4, MKV
    or WebM, the picture without them if they go only in tracks. QuickTime files can't hold them
    yet, nor does the native export write them: an export with them goes through the web view.
  - Typed while it plays: a line starts where its typing began, the film paused while typing
    if chosen, and lasts long enough to read (15 characters a second, 1 to 7 s) or until the
    next line. With no subtitle track, the panel offers to start one.
  - Snapped: each line's start to the nearest speech start or cut within 0.3 s, its end to the
    nearest speech end or cut (`snap_edges`), none left shorter than 0.2 s.
  - Translated side by side: a copy of the track's timing (`translationOf` the original), each
    line edited with the original it overlaps most shown above it.
  - Still to do: holding a key while a line is spoken; mov_text (tx3g) for Apple's players,
    which don't show WebVTT in MP4; Whisper's own word timings for auto-sync.
