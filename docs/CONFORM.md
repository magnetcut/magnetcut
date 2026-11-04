# Making the clips match

`docs/PLAN.md` step 13. Fast mode copies the main track's clips into one file only when they're
in one codec, one size and the same way up (docs/FAST.md); otherwise its Export can't start.
Here the editor converts the clips that differ, once, in the timeline, so every Fast export
after that is a copy. All four phases are built (Done, at the end).

## What's there

- Fast mode's rules for joining (`findJoinProblem`, `export/fast/exporter.ts`): one codec, one
  coded size, one rotation, and outside H.264 the same decoder configuration. The sound is
  copied when every clip's is in the same codec and settings, otherwise mixed and encoded,
  which costs little. The audio tracks are left out.
- In the desktop app, media files are read where they are (`apps/desktop/src/media.rs`,
  `DiskFile`): only files the user gave the app, kept between launches.
- A clip points at its media by `mediaId`. "Replace media" is in the clip's menu but disabled,
  and replacing a clip's media by dropping a file on it is "not yet implemented"
  (`drag-drop-controller.ts`): both are upstream's, never built.
- mediabunny's `Conversion`: it decodes, resizes (`fill`, `contain` with black bars, `cover`),
  turns the picture the way its rotation says, trims and encodes, with WebCodecs, so with the
  hardware codecs where the web view has them.
- Writing a file on disk: Export's (`apps/desktop/src/export.rs`), a path picked and written in
  chunks.

## Design

### When it shows
- Once Fast mode is the Export mode chosen (Export remembers it), the main track's clips that
  keep it from joining get a yellow "!" in a corner. Its tooltip says how the clip differs:
  "1280×720 H.264; most of the track is 1920×1080 H.264". Clicking it opens the dialog.
- Fast mode's red message gets a button, "Make the clips match…", which opens the same dialog.
- Nothing with Fast mode off: a normal export draws every frame anyway, and clips that differ
  don't matter to it.

### The dialog
- It says what differs, clip by clip, and that converting them once makes Fast exports copies.
- Size: each size on the track, with its share of the track's length. The default is the
  largest share, so the fewest frames are encoded again. It says how many clips will be
  converted, and how long they are.
- Codec: the most common one on the track that this computer can encode (H.264 everywhere,
  HEVC where the web view encodes it, VP9). The bitrate is the source's, scaled by the number
  of pixels.
- Fit, for a clip of another shape: black bars (the default), fill (cropped), or stretched.
- Sound, in the same pass: into the most common codec, sample rate and channels, so it can be
  copied as well.
- Whole files, or only the parts used and 5 seconds on each side, which is quicker for long
  recordings. A clip later trimmed out past those 5 seconds shows its "!" again.
- Where: beside the original, as "<name> (1920×1080).mp4", or in a folder picked. The
  originals aren't touched.

### What it does
- Each file that differs goes through a `Conversion` into a file on disk (Export's way of
  writing), one after another, with a progress bar and Cancel.
- Each new file is given to the app as an imported one is (granted in `media.rs`), and the
  clips that used the old file use the new one, their cuts kept: the times are the same in a
  whole file, and moved by where the part starts in a part. Undo swaps them all back in one step.
- That swap is the "Replace media" the clip's menu has disabled: it's built here, and turned on.

### Fast mode with it
- The audio tracks (music, voice-over) mixed into Fast mode's sound, as the clips' sound is when
  it can't be copied. The sound is still copied when there are no audio tracks.
- The red message's button, above.

## The phases

1. Replace media, from the clip's menu and by dropping a file on a clip, in one undo step;
   tested in code.
2. The "!", the dialog, the conversion into files on disk, and the swap; Fast mode's button.
   Checked in WKWebView, WebKitGTK, WebView2 (the probe) and Chrome: the converted files join,
   Fast mode copies them, and the copied frames are the source's.
3. Fast mode mixes the audio tracks in.
4. Proxies (issue #4), from the same parts: each file converted small, played in the preview,
   and the originals used at export.

## Risks

- A conversion is an encode: on Linux WebCodecs may encode in software (GStreamer), and a weak
  CPU is slow at it. The dialog says how much will be converted before it starts.
- Colour: WebKit's decoder gives full-range frames from limited-range video (docs/FAST.md).
  Resizing goes through a canvas, so the encoder converts from RGB itself. The converted files'
  range and matrix are checked against the originals' in WKWebView before phase 2 is done.
- Disk space: a whole 4K file converted is about as big as its original.

## Done

With these changes from the design above:

- Replace media (`media/replace.ts`): from the clip's menu ("Replace media…") and by dropping a
  file from Media on a clip. The clip keeps its name, place and cuts; a shorter file shortens
  it. A video takes a video, a picture a picture, sound takes sound or a video with sound. All
  the clips swapped at once are one Undo step.
- The target is always upright and H.264 or VP9 (`CONFORM_CODECS`): the codecs Smart Cut
  re-encodes, so the converted files work with both Fast modes. HEVC isn't offered: WebCodecs
  encodes it in few web views. The project's size is offered as well as the track's sizes.
- Files whose sound alone differs aren't converted: the sound is then mixed and encoded, which
  costs little.
- Where: the desktop app asks for a folder (beside the first file) and writes
  "<name> (1920×1080).mp4", or "<name> (1920×1080, 95-206 s).mp4" for a part, numbered if
  taken; it only writes in a folder picked (`open_folder_file`, `export.rs`), and the file is
  granted as an imported one (`adopt_saved_file`). In a browser the files are kept with the
  project, as imported ones are.
- Cancel deletes the file being written; the files already finished are kept and used. Fixed
  on the way: mediabunny's `Output.cancel()` closes its stream, which Export took as finished,
  so a cancelled export left its partial file behind. A file is now kept only when it's closed
  as finished (`close_export_file` with `keep`, and `toExportFile`'s states).
- Fast mode's button shows only when the problem is clips that differ (`canConform`), not a
  container that can't hold the codec.
- Phase 3 (`placeAudioTracks`, `export/fast/clips.ts`): under each clip, the part of the
  timeline its frames come from, moved to where the clip is in the output. Gaps closed up drop
  what was heard in them; a clip that starts at the key frame before its cut hears the timeline
  from as far before it. Keyframed volume is cut as a split cuts it. The sound is copied only
  when the audio tracks have nothing to hear, and a clip's sound moved to an audio track is
  heard there, once.
- Tests: `export/fast/__tests__/conform.test.ts`, `clips.test.ts`, `media/__tests__/replace.test.ts`.
- The web view probe runs the editor's own code (`apps/web/src/desktop/probe-checks.ts`, called
  by `apps/desktop/src/probe.js`): a camera's sort of film (x264, High, B-frames, 320×180,
  `apps/desktop/fixtures/x264-320x180.mp4`), the 64×64 B-frame film and the turned one
  converted to match it, into the probe's folder, and the three joined by No re-encoding.
  In WKWebView (this Mac on macOS 27, and GitHub's runner on macOS 26) and in WebKitGTK with
  GStreamer's bad and libav plugins: the 55 frames decoded from the join are the files' to the
  bit, AVFoundation decodes them all, and ffmpeg's are the same. With the base plugins only,
  WebKitGTK can't decode H.264, and the conversion says so. In WebView2, and in Chrome (the
  same check, headless, with the files in memory), the same, since the converted clips leave
  unsaid what the camera film does (below). While they said BT.601, the film's last two frames
  before them came out 42 and 43 levels off: Chromium draws a frame whose SPS says nothing in
  the colour the next source's SPS says (docs/FAST.md, Limits).
- Colour, the risk above, was real: WebKit's H.264 encoder writes limited range, under an SPS
  that says nothing of colour (so limited, in H.264), but its decoder config says full range and
  sRGB whatever frames it's given, and mediabunny writes the MP4's colour box from that config.
  ffmpeg, VLC and QuickTime go by the box: a converted clip's white of 231 showed at 214.
  `media/encoder-colour.ts` puts the config right from the SPS wherever the two disagree on the
  range, for conversions, proxies and the WebCodecs export; WebKit, which goes by the stream,
  showed them right all along. Since then ffmpeg reads the converted clip's levels as the
  original's (229 for 231, after resizing), and the probe checks that box and stream agree.
- The converted files say of their colour what a file that joins as it is says
  (`ConformPlan.colour`): its range (limited if unsaid), and its matrix, primaries and transfer
  where it says them; what it leaves unsaid, they leave unsaid, so each web view draws the join
  as it draws the files. Given RGB, each web view's encoder picks its own range: WebView2's
  wrote full range, which joined with a camera's limited range would show the converted clips
  washed out wherever the file is read in one range. So the pictures go to the encoder as I420
  (`media/yuv.ts`, about 10 ms for a 1080p picture), written in the colour the file will say:
  its SPS's, else its colour box's (WebKitGTK's encoder says BT.601 of frames that say
  nothing), else BT.709, which WebKit and Chromium draw a film that says nothing in, at any
  size (ffmpeg, VLC and mpv take one under 720 lines as BT.601; BT.601 there moved the colours
  in WKWebView by 8.4 on average). Chromium and WebKit on macOS 27 keep the range they're told.
  WebKit on macOS 26 marks such frames full range, but writes RGB in limited: a grey frame is
  encoded each way first (`chooseColourInput`, `convert.ts`) and the way that comes out in the
  range wanted is used, there RGB, in the encoder's BT.709.
- The probe checks it by converting the camera film itself: its colours should come out within
  6 levels on average of what went in (a wrong matrix moves them 13, resizing and encoding
  again about 3). WKWebView on macOS 27: 2.75, through I420; on macOS 26: 3.65, through RGB;
  WebView2: 3.25; Chrome: 3.08.
- Tried on the way: Apple's decoders don't take a join whose SPSs code the picture at different
  sizes (docs/FAST.md, Limits), which VideoToolbox's minimum of 192×96 makes of tiny films.
- Phase 4, proxies (`media/proxy.ts`): a video's whole file, not the parts used, so a clip can
  be trimmed anywhere; only videos with a long side over 1280, converted to 960 on the long side
  (960×540 for 16:9), H.264 at about 3 Mbit/s (VP9 where H.264 can't be encoded), picture only,
  as the sound is cheap to decode and the preview keeps reading the original's. Made from the
  Media panel's menu (Make a proxy, for the videos selected; Stop; Remove the proxy), one at a
  time, the tile showing how far it is and then "Proxy". In the desktop app they're files in
  the app's cache (`proxies_folder`, `export.rs`), granted as imported files are; in a browser
  they're kept with the project beside the asset's file (`<id>.proxy`). A proxy that's gone
  isn't missing media: the original plays.
- The preview swaps them in when it builds its scene (`buildScene` with `useProxies`, from
  `RenderTreeController`), under their own decoder key (`<id>#proxy`); Export and everything
  else build theirs without, so they read the originals. The renderer scales each frame by its
  own size, so a proxy of the same shape draws the same. "Proxies" in the preview's toolbar
  turns them off and on (kept between launches); it shows once there's one.
- Tests: `media/__tests__/proxy.test.ts` (the size, the name, the preview playing the proxy only
  when on, and an export never). Checked in Chrome: a 1920×1080 file's proxy made (an H.264
  MP4, 960×540, no sound), kept after a reload, played, turned off and on, and removed. In
  WKWebView by the probe: a 1920×1080 film of black, white, grey and red made, its proxy written
  in the app's cache (H.264, 960×540, no sound, 0.2 s), and both read back with the four colours
  as drawn.
