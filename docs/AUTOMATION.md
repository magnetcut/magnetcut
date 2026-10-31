# Agents steering MagnetCut

`docs/PLAN.md` step 12: Claude Code, Codex or any agent that speaks MCP opens a project, reads
the timeline, edits it, looks at and listens to it, and exports, in the app the user has open,
as cheaply in tokens as the job allows. Nothing leaves the computer. What's built is under Done.

## What was there

- The editor's model and every edit are TypeScript in the web view: `EditorCore` and its
  managers (timeline, scenes, project, media, renderer, save), each edit a command in
  `CommandManager`'s history, so undo and redo; `BatchCommand` runs several as one, and
  `TracksSnapshotCommand` swaps the tracks before for the tracks after. Reactors tidy up after
  each command (empty tracks go, transitions whose clips no longer touch go).
- Actions (`apps/web/src/actions`, docs/actions.md): 28 of them, for keys, buttons and menus.
  They act on the selection and the playhead ("split the selected clips here"), so they're the
  user's vocabulary, not an agent's: an agent names what it means.
- The Rust side: file access only to what the user gave (`media.rs`: picked or dropped files,
  kept with bookmarks for the App Store sandbox), exports only to a file picked in the save
  dialog (`export.rs`), the native export (`render/`). The probe (`MAGNETCUT_PROBE`) already
  runs the app from the command line and reports; the macOS menu already reaches the page as
  events (`emit_to("main", "menu", …)`). Both are how this works too.
- Projects live in the web view's IndexedDB, not in files on disk: there's no project file an
  agent could edit, and editing one under the open editor would race it anyway.
- What an agent would want to use is mostly there: Whisper on the computer with word
  timestamps, Find faces and Find plates, Track, black bars found by themselves, the waveform,
  Simple mode's export answers (`export/wizard.ts`: where it's going, a file size to fit, the
  picture's size and frame rate, the sound).

## How it works

- **MCP, from the app's own binary.** The agent starts `magnetcut --mcp` (on a Mac
  `/Applications/MagnetCut.app/Contents/MacOS/magnetcut --mcp`), which opens no window and speaks
  MCP on its standard input and output. It's a bridge: it finds the running app through a local
  socket (a Unix socket in the app's data folder; a named pipe on Windows) and relays each
  message both ways. If the app isn't running, it starts it and waits until the editor says it's
  ready. Settings shows the line to paste (`claude mcp add magnetcut -- …`; Codex's
  `[mcp_servers]` the same).
- **The user watches.** Edits happen in the window that's open, live: a strip at the top says
  which agent is connected, with Stop. Each batch of edits is one step of undo, named for the
  agent. Nothing runs headless until phase 4.
- **The logic stays in the web view.** Rust relays: a request becomes an `agent` event to the
  page, the page answers with a command (`agent_reply`), images come back as bytes. The page
  implements MCP itself (`initialize`, `tools/list`, `tools/call`, progress notifications), in a
  new `apps/web/src/agent/`, over the managers: the model is there, and moving it to Rust for
  this would be a rewrite for nothing. What's heavy and has no need of the model goes to Rust as
  it would anyway: loudness and silences (`rust/crates/audio`), shot changes on the native
  decoder's frames.
- **The App Store edition.** The sandbox lets the bridge run, launched from the same bundle, in
  the same container, so it finds the same socket; no network or server entitlement is needed
  for a Unix socket. What it can't do is reach files the user didn't give: so in both editions
  an agent reads and writes only media the project already has, folders the user granted in
  Settings ("Folders agents may use", picked in the open dialog and kept as bookmarks), and, in
  the App Store edition, Downloads. The same rule in both, so an agent's script works in either.
- **Off until switched on.** Settings, "Let agents use MagnetCut", off by default. The socket
  answers only with a token from a file only the user can read; nothing listens on the network.
  No tool downloads anything: where a model is missing (Whisper, the detectors), the tool says
  which and how big, and the window asks the user.

## Spending few tokens

- **The project as text, short.** `summary` gives a few lines a model reads at a glance:
  ```
  "Trip" 1920x1080 30fps 2:14.5 rev 41
  media m1 beach.mp4 1:32.0 3840x2160 h264+aac words | m2 music.mp3 3:10.0
  V1 c3f9a1 m1 0:00.0-0:12.4 src 4.0-16.4 | c8b20e m1 0:12.4-0:30.0 src 40.0-57.6 >dissolve 0.5
  T1 subtitles 42 lines 0:01.2-2:10.0
  A1 c71d0c m2 0:00.0-2:14.5 -12dB fade-out 3.0
  E1 ha03c2 blur face 0:03.0-0:09.0 tracked
  ```
  Ids are the first five characters of the element's own id (more only where two share them),
  so they stay the same across calls and launches with nothing stored. Times are seconds or
  `m:ss.s`; inputs take either, or frames as `f123`. Only what's set is shown: a clip at full
  volume says nothing about volume. `describe c3f9a` gives one element's every parameter,
  effect and keyframe, `describe T1` a track's lines: detail only when it's asked for.
- **Edits in batches.** `edit` takes a list of operations, each naming what it acts on: insert
  media at a time, cut at times, trim, move, delete with or without closing the gap, speed,
  volume and fades, text and titles, subtitle lines, transitions, effects and their parameters,
  keyframes, Hide regions. They run in order, as one transaction (`CommandManager` grouping the
  commands they make into one history entry), so one undo. It answers with what changed, as a
  diff in the summary's terms (`- c8b20e`, `~ c3f9a1 end 0:12.4>0:10.0`, `+ c55e1f …`), not the
  project again. `dryRun` gives the same diff and changes nothing. An error says which
  operation, which field and what would do (`op 3: c9999 isn't on the timeline`; `op 5: 95.0 is
  past the end of m1, 92.0`), and nothing of the batch is applied.
- **Changes from both sides.** Every answer has the project's revision; an `edit` gives the one
  it was planned on, and if the user changed something since, it's refused with the diff of
  what they did, so the agent replans on what's there rather than undoing the user's work.
- **Looking at the picture, small.** `look` renders frames with the editor's own compositor (as
  Track does), small, as JPEG: one at a time, or a contact sheet of up to 16 with their times
  printed on them, over a range or at the times given. A model pays for an image by its pixels
  (for Claude about width × height / 750 tokens), so a 640 × 360 sheet of twelve thumbnails is
  about 300 tokens, where the frames as text would be useless and a video impossible. The
  default size is the smallest that's useful; bigger when asked.
- **Listening, as text.** `listen` gives the transcript (Whisper, on the computer) as lines with
  their start times; words, numbered, with their times on request; silences longer than a
  length; loudness (integrated LUFS, true peak) and where it's too loud or too quiet; music or
  speech. So an agent edits a talk by its words: "cut words 120-134", "close every silence over
  0.6 s, leaving 0.15", as operations of `edit`.
- **Finding, as tools.** Shot changes, black bars, faces and plates (each found one a Hide
  region, as the panel does), Track: their answers in the same few lines.
- **Exporting by intent.** `export` takes Simple mode's answers (where it's going, a file size
  to fit, size and frame rate, the sound) or the Advanced settings, and a path in a granted
  folder. Progress comes as MCP
  notifications, not by polling; the answer is the file's path, size, duration and codecs, and
  any warning. It never writes over a file unless told to.
- **Few tools, short descriptions.** Each tool's description is in every request an agent makes,
  so there are about ten (`status`, `project`, `media`, `summary`, `describe`, `edit`, `undo`,
  `look`, `listen`, `find`, `export`), the operations of `edit` listed once in a line each. Their
  size is measured and kept under a budget.

## The phases

### 1. Connect, read, look, export
- Settings: the switch, the folders, the line to paste; the strip with Stop.
- The socket in Rust, the `--mcp` bridge, the relay to the page; MCP in the page.
- `status`, `project` (list, open, new), `media` (import from granted folders, list),
  `summary`, `describe`, `look`, `export` with progress.
- Tested in code (the summary of a fixture project against the text it should be, its length
  under a budget; the tool list's size) and on CI on all three systems: a Bun script as the MCP
  client starts the built app through `--mcp`, opens a project, imports a fixture, reads the
  summary, looks at a frame and exports, and the film is checked by the native decoder, as the
  probe's export is.

### 2. Edits in batches
- `edit` with its operations, the transaction, `dryRun`, the diff, the revision; `undo` and
  `redo`.
- Tested in code operation by operation (a project before, the operations, the diff and the
  project after), and on CI: the script cuts, trims, adds a title and a transition, exports,
  and checks the film's length and frames.

### 3. Listening and finding
- Transcripts with words, cutting by words and silences, loudness and evening it out, shot
  changes, black bars, faces and plates, Track.
- Tested on generated fixtures where the answer is known: a tone with silences at given times,
  cuts between colours, speech made by the system's own voice (`say` on a Mac).
- Then tried by hand: Claude Code making a short edit of a talk from its transcript, and how
  many tokens it took, written under Done.

### 4. Headless and the command line
- `--mcp --hidden`: the app without its window, for agents on their own (a script, CI). The web
  view must still render with no window showing: hidden, or off screen where a system throttles
  hidden ones.
- `magnetcut call <tool> '<json>'` over the same socket, for agents that only have a shell, and
  for scripts.

## Risks
- A web view with no window may slow or stop its timers and drawing (WKWebView does when it
  can't be seen). Phases 1 to 3 have the window open; phase 4 finds what each system allows.
- Windows: an app built for the GUI has no console, but its standard input and output still
  work when the agent gives it pipes, which MCP clients do; to be checked on CI from phase 1.
- The sandboxed binary started from a terminal rather than by the Finder: to be checked with
  the App Store build in phase 1, and App Review told what the socket is for.
- A model that edits badly does it fast: the dry run, one undo per batch, the revision, the user
  watching, and exports that never overwrite are the answer; and an agent has only the files
  the user gave.
- Any program running as the user could connect once the switch is on, as it could already
  open the user's files: the token stops other users, the switch everyone until it's wanted.
- The tools' descriptions cost tokens on every request: kept few and short, and measured.

## Done
