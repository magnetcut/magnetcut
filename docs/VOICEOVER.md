# Voice-over

`docs/PLAN.md` step 13; issue #1 has voice-over in it. Two ways in, from a Voice-over panel:
recording from the microphone, or the subtitles spoken. Built (Done, at the end), with this
computer's own voices in place of Kokoro.

## What's there

- Subtitle tracks: text tracks with `subtitles` on them, each cue a text clip with its start and
  end (docs/SUBTITLES.md), from an SRT, typed, or Whisper's.
- Whisper runs with transformers.js, its models downloaded once from Hugging Face (PLAN.md lists
  that download with the others).
- The time-stretch that keeps the pitch (`rust/crates/audio`).
- Media files given to the app are read where they are (`apps/desktop/src/media.rs`).
- No microphone yet: the Info.plist has no `NSMicrophoneUsageDescription`, the entitlements no
  `com.apple.security.device.audio-input`, and WebKitGTK's media streams aren't turned on
  (`apps/desktop/src/webkit.rs`).

## Design

### Recording
- The Voice-over panel, a tab in the left panel (a microphone): the input picked, its level
  meter, and Record. Recording starts at the playhead with the timeline playing (muted, or heard
  in headphones, as chosen), after a 3-2-1 count; Stop ends it. The take goes on the voice-over
  track, a new audio track the first time, at the playhead.
- Captured as samples (getUserMedia into an AudioWorklet), and written as it's recorded into a
  WAV file by the desktop app: a command that writes a recording and gives it to the app as an
  imported file is. The folder is picked once (Music/MagnetCut by default). A crash leaves what
  was recorded.
- The web view's echo cancellation, gain control and noise suppression: off by default, since
  they colour the voice; a switch turns them on.
- Each take is its own file. A new take over a clip replaces it, and the earlier take's file
  stays.
- Isolate voice: Reduce noise from docs/AUDIO-EFFECTS.md, set on the clip so it can be turned
  off later, with the Voice preset if it's chosen.
- Permissions: macOS asks once (`NSMicrophoneUsageDescription`, and the audio-input entitlement
  in both editions); WebView2 and WebKitGTK ask in their own way, or need it turned on (wry's
  permission handling). The probe checks first, in each web view: getUserMedia works and a
  second is recorded.

### Speaking the subtitles
- Pick a subtitle track, a provider and a voice. The number of characters is shown before
  anything is sent, and for ElevenLabs what's left in the account. Speak makes a clip for each
  cue on a new audio track, at the cue's start.
- When the speech is longer than its cue, it's sped up with the time-stretch, up to 1.25 times.
  Past that it's left long and marked, so the cue's text can be shortened. A clip that would
  run into the next one is marked the same way.
- A cue already spoken isn't sent again unless its text or the voice has changed.
- The providers:
  - ElevenLabs: its text to speech, with a voice from the account's list and its models.
  - OpenAI: its speech endpoint and voices, with whichever text-to-speech models it offers at
    the time (read from the provider, not written into the app), and the instructions ("calm,
    warm") for the models that take them.
  - On this computer: the system's own voices (AVSpeechSynthesizer on macOS, WinRT's
    SpeechSynthesizer on Windows, espeak-ng on Linux). No key, no account, no download, and the
    text stays on the computer. (Kokoro was the plan, but kokoro-js turns text into phonemes
    with espeak-ng compiled in, which is GPL.)
- Keys: typed once in Settings and kept in the system's keychain (the macOS Keychain, the
  Windows Credential Manager, the Secret Service on Linux; the `keyring` crate). The desktop app
  sends each one only to its provider, so the web view doesn't hold it once it's typed. Settings
  shows whether a key is set, and removes it.
- The requests come from Rust. reqwest with native-tls is already built into the direct
  download for the updater, but the App Store edition has no updater, so it becomes a dependency
  of its own (licences checked with `bun run licenses`).
- Translations: a translated subtitle track (`translationOf`) spoken in its language makes a
  dubbed version.

### The network
- ElevenLabs and OpenAI, only when they're picked in the panel (their voices, models and, for
  ElevenLabs, the characters left) and when Speak is used, with the user's own key. What's sent
  is the cues' text and the voice's settings. PLAN.md and CLAUDE.md list them with the others,
  and nothing else is added.

## The phases

1. The microphone in the three web views (the probe), the permissions, recording into a file,
   and the panel.
2. This computer's voices: the subtitles spoken and fitted to their cues.
3. ElevenLabs and OpenAI: keys in the keychain, requests from the desktop app, the voices
   listed, the characters counted.
4. Isolate voice, once Reduce noise (docs/AUDIO-EFFECTS.md) is built.

## Risks

- A provider changes its API: each one is a small module of its own, and its models and voices
  are read from it rather than written into the app.
- Cost: a long film's subtitles spoken by ElevenLabs or OpenAI cost real money. The count is
  shown first, and cues already spoken aren't sent again.
- The system's voices vary: the Mac's enhanced and premium voices are good once downloaded
  (System Settings, Accessibility, Spoken Content), espeak-ng sounds robotic.

## Done

- The panel is `voiceover/components/voiceover-panel.tsx`, the Voice-over tab (a microphone)
  after Captions. Record and Speak the subtitles are its two sections.
- Recording (`voiceover/recorder.ts`, `voiceover/recording.ts`): getUserMedia (no echo
  cancellation, gain control or noise suppression unless Call-style processing is on), an
  AudioWorklet made from a Blob URL that posts each block while recording, mono 16-bit WAV
  (`voiceover/wav.ts`). The worklet has a silent output to the speakers, since a node nothing
  pulls on isn't run in every web view. In the desktop app the take is a file from its first
  block (`open_folder_file`, the export's positional writes), the header brought up to date
  every second, and Stop adopts it as media (`adopt_saved_file`); in a browser it's kept in
  memory and added to the project at Stop. The state is a store, so a take goes on while
  another tab is shown; the microphone is let go when the tab closes otherwise.
- The folder: Music/MagnetCut (`recordings_folder` in `apps/desktop/src/export.rs`, made if
  it isn't there), or one picked with Change…; spoken cues go there too.
- Placing (`voiceover/place.ts`): the takes go on the "Voice-over" audio track, the spoken cues
  on "Spoken subtitles". What a new sound covers on those tracks is deleted (a take over a take
  replaces it; the earlier file stays), sounds that overlap each other go on "… 2", "… 3", and
  it's one step that Undo takes back. Fixed on the way: `AddTrackCommand` dropped an audio
  track's name, so those tracks were called "Audio", and each take or cue spoken again went on
  a new one instead of replacing what it covered.
- Dubbing: Captions' Translate makes a translation track timed as the original
  (`addTranslationTrack`, `subtitles/insert.ts`), its lines written over in the other language;
  spoken with a voice in that language (the panel says so when a translation is picked), its
  cues go on a track of their own, "Spoken subtitles: <its name>" (`spokenTrackName`), so the
  dubbed version is beside the original's speech, not over it.
- Isolate the voice sets Reduce noise (docs/AUDIO-EFFECTS.md) to 0.85 on the take, which its
  Audio tab changes.
- Permissions: the Info.plist's `NSMicrophoneUsageDescription`; the audio-input entitlement in
  `Direct.entitlements` (new, for the hardened runtime) and `AppStore.entitlements`, which also
  gets Music read-write for the folder; `on_permission_request` in `main.rs` grants the
  microphone and refuses the camera; WebKitGTK's media streams are turned on in `webkit.rs`.
- Speaking (`voiceover/speech.ts`, `apps/desktop/src/speech.rs` and `speech/`): the keys in the
  keychain (the `keyring` crate, service `<bundle id>.speech`), never sent back to the web view;
  Settings has Voices for the subtitles to set and remove them. Requests from Rust with reqwest
  and native-tls. The cues are sent one at a time (ElevenLabs limits how many at once), each kept
  as a WAV named by a few of its words and a hash of the text, voice, model and instructions,
  so a cue spoken the same way again comes from the project instead. Fitted with the
  time-stretch, pitch kept, up to 1.25 times; the cues that still run over are listed, and
  clicking one moves the playhead there. The characters to send are shown first, and
  ElevenLabs' monthly count.
- OpenAI's models are read from the account (those with "tts" in their id), the default
  `gpt-4o-mini-tts`, which takes the instructions ("How it's said"). The older tts-1 models may
  be retired; the list follows what the account has.
- Tested: `voiceover/__tests__` (the WAV header and length, lanes, cue text, keys, file names,
  fitting) and `speech/tests.rs` (WAV reading and writing, ElevenLabs and OpenAI against a local
  server). Checked in Chrome: a take recorded from a stand-in microphone (a 440 Hz tone), placed
  at the playhead, with Reduce noise on.
- The probe (`apps/web/src/desktop/probe-checks.ts`) records a second through the recorder, into
  the probe's folder, from a stand-in tone and, with `MAGNETCUT_PROBE_MICROPHONE` set, from the
  microphone (on GitHub, WebView2's and WebKitGTK's stand-in devices, still asked for through the
  app's permission handler), and speaks a sentence with the system's voice (espeak-ng installed
  on Linux). In WKWebView: the take 1 s at 48 kHz from the tone, 180 voices, the sentence 2.6 s.
  From the Mac's own microphone, in the bundled app (opened with `open --env`, so that macOS
  asks for MagnetCut): a take with the room's noise in it. Run from a terminal, macOS goes by
  the terminal's permission and gives silence, with no error.
- On GitHub: in WebKitGTK the take from the tone (1 s at 44.1 kHz) and from the stand-in
  microphone (WebKit's mock capture device, `webkit.rs`), granted by the app's permission
  handler; espeak-ng's 130 voices, the sentence 2.3 s. In WebView2 the take from the tone and
  the system's 3 voices (David, Mark, Zira), the sentence 2.8 s. WebView2 is given Chromium's
  stand-in microphone by a flag in the window's `additionalBrowserArgs` (`TAURI_CONFIG`, in the
  workflow: wry sets the web view's arguments itself, so `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
  is ignored): with it, a take of 1 s of its beep, asked for through the app's permission
  handler. The macOS runner has no microphone: its take is silence.
- The probe dubs a translation in each web view, with the panels' own code: a project with two
  English lines, Translate, the lines written in the first of Italian, French, German or
  Spanish one of the system's voices speaks (English where there's none, as on GitHub's
  Windows), the original spoken with the system's voice and the translation with that one, the
  clips looked for on their two tracks at the lines' starts, and the translation spoken again,
  from the project. In WKWebView (this Mac and GitHub's): Alice (it-IT), "Buongiorno a tutti."
  and "Ci vediamo domani." at 0.5 and 3.5 s on "Spoken subtitles: Subtitles (translation)",
  the English beside them on "Spoken subtitles", both again from the project. In WebKitGTK the
  same with espeak-ng's Italian; in WebView2, whose runner has only English voices, the
  translation in English with David, on its own track the same.
- Not checked yet: a real key with each provider, which only the user can type in Settings.
