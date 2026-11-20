---
name: magnetcut
description: Edit and export videos in the MagnetCut app open on this computer, through its MCP tools (summary, edit, look, listen, find, export). Use when the user asks to cut, trim, assemble, caption, clean up or export a video or a MagnetCut project.
---

# Editing with MagnetCut

MagnetCut is a video editor running on this computer. Its MCP server (`magnetcut`) acts on the
window the user has open: every change shows there as you make it, each `edit` batch is one
step of the user's Undo, and the user can stop you from the strip at the top of the window.

## Before the first call

- If the tools don't answer, MagnetCut isn't running, or agents are switched off. Open it as
  you open any app (`open -a MagnetCut` on a Mac, `magnetcut` on Linux, MagnetCut from the Start
  menu on Windows), then ask the user to check Settings, Agents if it still doesn't answer.
- `status` says what's open. `project` lists, makes, opens and saves projects (`.magnetcut`
  files by their whole path).

## Read little, then act

1. `summary`: the open project in a few lines. Media are `m1`, `m2`…; clips, tracks and
   effects have short ids (`c3f9a`), the same from call to call. Note the `rev`.
2. `describe <id>` only for the one thing whose detail you need (every parameter, keyframe or
   subtitle line).
3. `look` to see the picture: a contact sheet of small frames over a range is cheap (about 300
   tokens for twelve frames at 640 wide); ask for one bigger frame only when detail matters.
4. `listen` to hear it as text: the transcript in lines, words numbered with their times,
   silences, loudness (LUFS). Transcribing runs on the computer and may first ask the user to
   download a model.
5. `find`: shots, black bars, faces and plates (each found one becomes a Hide region), or
   track a Hide region through its frames.

## Edit in batches

- `edit` takes a list of operations, done in order as one transaction: `insert`, `text`,
  `cut`, `trim`, `move`, `delete` (with `close` to leave no gap), `remove` (stretches out of
  every track, closed up: words or silences from `listen`), `transition`. Times are seconds,
  `m:ss.s` or `f<frame>`.
- Use `dryRun` first for anything large: it answers with the changes and changes nothing.
- The answer is the diff, not the project again: don't call `summary` after every edit.
- An edit planned on an old `rev` is refused when the user has changed something since:
  read the new summary and plan again on what's there. Never undo the user's own work.
- `undo` (or redo) takes back a whole batch.

Typical jobs:

- Tighten a talk: `listen` silences (or words), then one `edit` with `remove` and the ranges.
- Assemble: `media` import with the whole paths (`add` to put them on the timeline in order),
  then `cut`, `trim` and `transition` in one batch.
- Titles: `text` with the words, where they start and end.

## Export

- `export` with the whole path; its extension picks the format (`.mp4`, `.mov`, `.mkv`,
  `.webm`). Say where it's going (`destination`: anything, upload, small, master), and
  optionally a size to fit (`maxMegabytes`), `shortSide` (1080, 720…), `fps` and `sound`.
  MagnetCut picks the settings as its Simple mode does.
- It never writes over a file unless you pass `replace`. Progress arrives as notifications.
- In the App Store edition, files outside the folders the user allowed are refused or asked
  for: say so to the user rather than retrying.

## Manners

- Tell the user what you're about to change before a big batch, and what changed after.
- Media stay where they are on disk; MagnetCut never copies or uploads them.
