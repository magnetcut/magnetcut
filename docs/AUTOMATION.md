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
- Projects live in the web view's IndexedDB, not in files on disk: there's no project file to
  open or save, for an agent or for the user.
- What an agent would want to use is mostly there: Whisper on the computer with word
  timestamps, Find faces and Find plates, Track, black bars found by themselves, the waveform,
  Simple mode's export answers (`export/wizard.ts`: where it's going, a file size to fit, the
  picture's size and frame rate, the sound).

## How it works

- **Served by the app itself.** With the switch on, the running app serves MCP over HTTP
  (MCP's Streamable HTTP) at `http://127.0.0.1:<port>/mcp`, the port picked once and kept, in
  both editions. No second process and no bridge: the agent talks to the window that's open.
  Settings gives the lines to paste, with the agent's token in them. For Claude Code:
  ```
  claude mcp add --transport http magnetcut http://127.0.0.1:47213/mcp \
    --header "Authorization: Bearer mc_…"
  ```
  For Codex, `codex mcp add magnetcut --url http://127.0.0.1:47213/mcp
  --bearer-token-env-var MAGNETCUT_TOKEN`, and the variable to set. If the app isn't running,
  the agent opens it as it opens any app (`open -a MagnetCut`, or the binary). A `magnetcut --mcp`
  mode, MCP on standard input and output, relaying to the app, comes in phase 4, for clients that
  speak only that.
- **Authentication: a token for each agent.** Settings, Agents: Add, a name ("Claude Code on
  this Mac"), and MagnetCut shows a token once (32 random bytes, `mc_` and base64url), in the
  line to paste; it keeps only its SHA-256, in the app's own data, not the web view's. Each
  agent is listed with when it was last used, and Revoke ends it at once. Every request must
  carry a token that's there (`Authorization: Bearer`); any other gets 401 and nothing else. The
  server listens on 127.0.0.1 only, never on the network, and refuses a request whose `Host`
  isn't that address and port, or that has an `Origin` (a web page's), so a site open in a
  browser can't reach it by DNS rebinding or a form. Tokens are never logged. The switch off
  closes the port.
- **The user watches.** Edits happen in the window that's open, live: a strip at the top says
  which agent is at work, with Stop. Each batch of edits is one step of undo, named for the
  agent. Nothing runs headless until phase 4.
- **The logic stays in the web view; the door is in Rust.** Rust serves HTTP (a small server on
  its own thread), checks the token, speaks MCP's JSON-RPC (`initialize`, `tools/list`,
  `tools/call`, progress as server-sent events), and hands each tool call to the page as an
  `agent` event; the page answers with a command (`agent_reply`), images as bytes. The tools are
  in a new `apps/web/src/agent/`, over the managers: the model is there, and moving it to Rust
  for this would be a rewrite for nothing. What's heavy and has no need of the model goes to
  Rust as it would anyway: loudness and silences (`rust/crates/audio`), shot changes on the
  native decoder's frames.
- **Any file the agent names (outside the App Store).** An agent works on the user's files
  already, with the user's own permissions: MagnetCut doesn't fence it in further. In the
  edition from the website, a tool takes any absolute path: media imported from where it is (as
  the desktop app already keeps media, by path), a project opened from or saved to a file, an
  export written anywhere. Exports and saved projects never replace a file unless the call says
  so; nothing is ever deleted.
- **Project files.** Agent mode brings `.magnetcut` files, for the user as much as for agents:
  the project as JSON, its media by path, with File, Open and Save As in the menu. An agent opens
  one, or writes one and opens it, keeps versions in git, or makes a project from a script; the
  one open in the window is still the one edited live, and saving writes the file.
- **The App Store edition.** The sandbox is Apple's, not ours: the app can open only what the
  user gave it. So there, a path in the Movies or Downloads folders works as it does elsewhere
  (their entitlements, Movies to be added), and so does one in a folder granted in Settings
  (kept as a bookmark); any other, and the window asks: an open or save dialog at the path the
  agent named, one click, and the grant is kept. Serving on 127.0.0.1 needs the
  `com.apple.security.network.server` entitlement, which App Review grants when it sees why:
  the Agents settings and a sentence in the review notes. If it's refused, agent mode ships in
  the website's edition first.
- **Off until switched on.** Settings, "Let agents use MagnetCut", off by default, and no agent
  without its token. No tool downloads anything: where a model is missing (Whisper, the
  detectors), the tool says which and how big, and the window asks the user.

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
  to fit, size and frame rate, the sound) or the Advanced settings, and a path (in the App
  Store edition, one the sandbox allows, or asked for). Progress comes as MCP
  notifications, not by polling; the answer is the file's path, size, duration and codecs, and
  any warning. It never writes over a file unless told to.
- **Few tools, short descriptions.** Each tool's description is in every request an agent makes,
  so there are about ten (`status`, `project`, `media`, `summary`, `describe`, `edit`, `undo`,
  `look`, `listen`, `find`, `export`), the operations of `edit` listed once in a line each. Their
  size is measured and kept under a budget.

## The phases

### 1. Connect, read, look, export
- Settings: the switch, Agents (add, the token once with the lines to paste, revoke); the strip
  with Stop.
- The HTTP server in Rust: 127.0.0.1, tokens, `Host` and `Origin` checked, MCP's JSON-RPC, the
  relay to the page.
- `status`, `project` (list, open, new; open and save `.magnetcut` files), `media` (import any
  path, list), `summary`, `describe`, `look`, `export` with progress.
- Tested in code (the summary of a fixture project against the text it should be, its length
  under a budget; the tool list's size; requests with no token, a revoked one, a foreign `Host`
  or an `Origin`, all refused) and on CI on all three systems: a Bun script as the MCP client
  starts the built app with agent mode on and a test token, imports a fixture by its path, reads
  the summary, looks at a frame, saves and reopens the project as a file, and exports; the film
  is checked by the native decoder, as the probe's export is.

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
- `--hidden`: the app without its window, for agents on their own (a script, CI). The web view
  must still render with no window showing: hidden, or off screen where a system throttles
  hidden ones.
- `magnetcut --mcp`, MCP on standard input and output relayed to the app, for clients that
  speak only that; `magnetcut call <tool> '<json>'`, for agents that only have a shell, and for
  scripts. Both with a token.

## Risks
- A web view with no window may slow or stop its timers and drawing (WKWebView does when it
  can't be seen). Phases 1 to 3 have the window open; phase 4 finds what each system allows.
- App Review and the server entitlement: a refusal keeps agent mode to the website's edition
  until it's answered.
- A port taken by something else: the next free one, kept, and the lines to paste updated.
- Windows, phase 4: an app built for the GUI has no console, but its standard input and output
  still work when given pipes, as MCP clients give them; to be checked on CI.
- A model that edits badly does it fast: the dry run, one undo per batch, the revision, the user
  watching, and exports that never overwrite are the answer; and an agent has only the files
  the user gave.
- A token is a key: anyone who has one can edit and export, and read files as the app can.
  It's shown once, kept only hashed, revoked in a click, and useless from another computer.
- The tools' descriptions cost tokens on every request: kept few and short, and measured.

## Done
- Phase 1, most of it. The server in Rust (`apps/desktop/src/agent/`): HTTP/1.1 on 127.0.0.1,
  one request a connection, 16 MB at most; a token for each agent, kept as its SHA-256 with
  the switch and the port in `agents.json`, compared in constant time; a request with an
  `Origin`, another `Host` or no good token refused before it's read as MCP; JSON-RPC with
  `initialize`, `ping`, `tools/list` and `tools/call`, progress as server-sent events. A path is
  opened for the editor only if it's in that agent's call. Tested in code: refusals, revoking,
  notifications, the tools listed, a call handed on with its progress streamed back. Settings,
  Agents: the switch, the agents with when each was last used, Revoke, and Add, which shows the
  token once in the lines for Claude Code and Codex; the strip with Stop. The tools (`apps/web/
  src/agent/`): `status`, `project` (list, new, open), `media` (import by path, onto the
  timeline too; list), `summary`, `describe`, `look`, `export`. On CI on all three systems
  (`.github/workflows/probe.yml`, `apps/desktop/scripts/agent-check.ts`), the built app with a
  test token and a script as the MCP client: a wrong token refused, the seven tools listed
  (2,832 bytes of descriptions), a project made, a film imported onto it, the summary read (119
  characters), a clip described, a sheet of four frames looked at, an H.264 MP4 exported with
  12 progress notes, and a second export to the same path refused. The App Store edition may
  now listen and use Movies (its entitlements, and the review note in docs/RELEASING.md). Left
  of phase 1: `.magnetcut` project files, and in the App Store edition the folders granted in
  Settings and the dialog for a path outside them (for now, such a path is refused, saying why).
