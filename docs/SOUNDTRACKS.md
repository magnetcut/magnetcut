# Several soundtracks

`docs/PLAN.md` step 13, with issue #1 (audio). One exported file with more than one soundtrack:
the film's sound, and a commentary, another language's dub or a version without music, each a
track a player lets you pick. In the timeline the audio tracks are grouped into soundtracks by
a band on their left; there's one by default, holding everything, and "+ Add soundtrack" makes
another. Nothing is built yet.

## What's there

- A scene's tracks (`SceneTracks`): the overlays, the main track and the audio tracks, each
  audio track `{ id, name, elements, muted }`. The track labels panel
  (`timeline/components/index.tsx`, `TrackLabelsPanel`) lists them in that order.
- The preview plays every clip's sound and every audio track's through the master and the
  limiter (`core/managers/audio-manager.ts`).
- The export mixes them all into one sound (`media/audio-mix.ts`) and adds one audio track to
  the file (`services/renderer/scene-exporter.ts`), or one copied from the source when nothing
  changed it. Fast mode does the same, its audio tracks mixed in (docs/CONFORM.md).
- mediabunny writes several audio tracks, each with a name, a language (ISO 639-2) and a
  disposition (default, original, commentary, hearing or visually impaired):
  `output.addAudioTrack(source, { name, languageCode, disposition })`. MP4, MOV, MKV and WebM
  hold several; MP3 and WAV one (`getSupportedTrackCounts`).
- Projects are versioned and migrated (`services/storage/migrations`, now version 31).

## Design

### The model
- A scene gets `soundtracks: { id, name, languageCode?, disposition, hasClipSound }[]`, never
  empty, and each audio track a `soundtrackId`. A project from before has one soundtrack, "Main",
  holding every audio track (a migration, version 32).
- `hasClipSound`: whether the clips' own sound (the main and overlay tracks' video clips) is in
  it. On for the first soundtrack. A new one asks: a commentary wants the film's sound under it,
  a dub usually doesn't (and a separate music and effects mix would be its own audio tracks).
- A soundtrack's audio tracks are kept together, in the soundtracks' order: moving a track into
  another band moves it in the list.

### The timeline
- Left of the audio tracks' labels, a band for each soundtrack, as tall as its tracks, with its
  name written up it and its colour. Clicking the name renames it; its menu sets the language,
  what it's for (the disposition), the clips' own sound, and removes it (its tracks go to the
  first, as Undo can take back).
- "+ Add soundtrack" under the last band: a new band with one empty audio track in it.
- Dragging a track's label onto another band moves the track there. A clip dragged onto a track
  goes in that track's soundtrack, as it goes on that track now.
- With one soundtrack, the band is a thin line and only the button shows, so a project that
  doesn't use this looks as it does now.

### Hearing them
- One soundtrack is heard at a time in the preview: a headphones button on each band, the first
  by default. The others' tracks are dimmed. The clips' own sound plays only if the heard one
  has it.
- Solo and mute on tracks stay as they are, inside the heard soundtrack.

### The export
- Each soundtrack mixed on its own (`audio-mix.ts` run once per soundtrack, the limiter on each)
  and added as an audio track with its name, language and disposition; the first is the default.
  The copy of a source's sound works for a soundtrack that is only the clips' own sound, as now.
- The export dialog lists them with a check each, all on. A format that holds one (MP3, WAV, or
  a preset that asks for one) takes the heard one, and says so.
- Fast mode: each soundtrack as Fast mode makes its sound now (copied when it can be, otherwise
  mixed and encoded), one after the other.
- The voice-over (docs/VOICEOVER.md): Speak the subtitles can put a translated subtitle track's
  speech into a new soundtrack in that language: a dub.
- Agents (docs/AUTOMATION.md): the soundtracks are in the project's summary, and the edit tools
  make, rename and move tracks between them.

## The phases

1. The model and its migration, the bands, adding, renaming, removing, moving tracks between
   them, and hearing one in the preview. Tests on the migration and on the order kept.
2. The export: a mix per soundtrack, the tracks named and marked, the dialog's checks, the
   one-track formats. Tested by reading an export back with mediabunny: the tracks, their
   names, languages and lengths.
3. Fast mode, the dub from Speak the subtitles, and the agents' tools.

## Risks

- Many players play only the default track and don't offer the others: QuickTime, VLC, mpv
  and Infuse do; browsers' video element mostly doesn't, and the big sites take the first. The
  export says the first is what most places play.
- A soundtrack per language with its own clips makes edits to the picture harder to follow:
  whatever moves the audio tracks along with the main track (ripple edits, cuts removed) has to
  move every soundtrack's tracks alike.
- Each soundtrack mixed and encoded costs export time, a little for each.
