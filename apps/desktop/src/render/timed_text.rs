// What Media Foundation's MP4 sink can't write, added to the finished file:
// subtitle tracks, as timed text (3GPP tx3g, the "mov_text" players show),
// and the program that wrote it. The film's index (moov) is read; the lines
// go in a new mdat in its place, where it's at the end as that writer puts
// it, and the index follows them with a track for each. Elsewhere, the old
// index is left as free space. Nothing else moves, so the other tracks'
// offsets hold.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use super::settings::{SubtitleCue, SubtitleTrack, WRITING_APP};

// The subtitle tracks' time scale: milliseconds.
const TIMESCALE: u32 = 1000;

/// A track's samples, one after another from zero, as (start, end, text):
/// each line, and an empty sample for each stretch with none, which clears
/// the screen (as `subtitle.rs` writes them on a Mac).
pub fn samples(cues: &[SubtitleCue]) -> Vec<(f64, f64, String)> {
    let mut cues: Vec<&SubtitleCue> = cues.iter().filter(|cue| cue.end > cue.start).collect();
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut samples = Vec::new();
    let mut at = 0.0;
    for cue in cues {
        let start = cue.start.max(at);
        if cue.end <= start {
            continue;
        }
        if start > at {
            samples.push((at, start, String::new()));
        }
        samples.push((start, cue.end, cue.text.clone()));
        at = cue.end;
    }
    samples
}

/// A timed text sample: the text's length in bytes, big end first, then the
/// text in UTF-8; empty, it clears the screen.
fn sample_data(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let length = bytes.len().min(usize::from(u16::MAX));
    let mut data = Vec::with_capacity(length + 2);
    data.extend((length as u16).to_be_bytes());
    data.extend(&bytes[..length]);
    data
}

/// A box: its size and type, then what's in it.
fn boxed(kind: &[u8; 4], content: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(content.len() + 8);
    data.extend((content.len() as u32 + 8).to_be_bytes());
    data.extend(kind);
    data.extend(content);
    data
}

/// A full box: a box with a version and flags first.
fn full_box(kind: &[u8; 4], version: u8, flags: u32, content: &[u8]) -> Vec<u8> {
    let mut data = vec![version];
    data.extend(&flags.to_be_bytes()[1..]);
    data.extend(content);
    boxed(kind, &data)
}

/// The boxes in `data`, as (type, start, end), the start being the box's own.
fn children(data: &[u8]) -> Result<Vec<([u8; 4], usize, usize)>, String> {
    let mut boxes = Vec::new();
    let mut at = 0;
    while at + 8 <= data.len() {
        let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap_or_default()) as usize;
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap_or_default();
        let size = match size {
            0 => data.len() - at,
            1 if at + 16 <= data.len() => {
                u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap_or_default()) as usize
            }
            size => size,
        };
        if size < 8 || at + size > data.len() {
            return Err("the film's index is damaged".into());
        }
        boxes.push((kind, at, at + size));
        at += size;
    }
    Ok(boxes)
}

/// The film's duration, in its time scale, from its movie header, and where
/// the next track id is in it.
fn movie_header(mvhd: &[u8]) -> Result<(u64, usize), String> {
    let short = || "the film's movie header is short".to_owned();
    let number = |at: usize, width: usize| -> Result<u64, String> {
        let bytes = mvhd.get(at..at + width).ok_or_else(short)?;
        Ok(bytes
            .iter()
            .fold(0u64, |value, &byte| (value << 8) | u64::from(byte)))
    };
    // After the box's 8 bytes: version and flags; then creation and
    // modification times, the time scale and the duration (8 bytes each of
    // the times in version 1); then 76 bytes of rate, volume, matrix and so
    // on, then the next track id.
    let (duration, next_id) = match mvhd.get(8) {
        Some(1) => (number(32, 8)?, 40 + 76),
        Some(0) => (number(24, 4)?, 28 + 76),
        _ => return Err("the film's movie header is of an unknown version".into()),
    };
    number(next_id, 4)?;
    Ok((duration, next_id))
}

/// A tx3g track: `id`, of `duration` in the film's time scale, its samples'
/// data at `offset` in the file, one after another.
fn track(
    id: u32,
    duration: u64,
    samples: &[(f64, f64, String)],
    offset: u64,
    (width, height): (u32, u32),
) -> Vec<u8> {
    let identity: [u32; 9] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000];
    let box_height = (height / 6).max(16);
    let mut tkhd = Vec::new();
    tkhd.extend(0u32.to_be_bytes()); // created
    tkhd.extend(0u32.to_be_bytes()); // modified
    tkhd.extend(id.to_be_bytes());
    tkhd.extend(0u32.to_be_bytes());
    tkhd.extend((duration.min(u64::from(u32::MAX)) as u32).to_be_bytes());
    tkhd.extend([0; 8]);
    tkhd.extend((-1i16).to_be_bytes()); // layer: above the picture
    tkhd.extend(0u16.to_be_bytes()); // alternate group
    tkhd.extend(0u16.to_be_bytes()); // volume
    tkhd.extend(0u16.to_be_bytes());
    for value in identity {
        tkhd.extend(value.to_be_bytes());
    }
    tkhd.extend((width << 16).to_be_bytes());
    tkhd.extend((box_height << 16).to_be_bytes());
    // Enabled, in the movie.
    let tkhd = full_box(b"tkhd", 0, 0x3, &tkhd);

    let total_ms = samples
        .last()
        .map_or(0, |(_, end, _)| (end * f64::from(TIMESCALE)).round() as u32);
    let mut mdhd = Vec::new();
    mdhd.extend(0u32.to_be_bytes());
    mdhd.extend(0u32.to_be_bytes());
    mdhd.extend(TIMESCALE.to_be_bytes());
    mdhd.extend(total_ms.to_be_bytes());
    mdhd.extend(0x55c4u16.to_be_bytes()); // "und"
    mdhd.extend(0u16.to_be_bytes());
    let mdhd = full_box(b"mdhd", 0, 0, &mdhd);
    let mut hdlr = vec![0; 4];
    hdlr.extend(b"sbtl");
    hdlr.extend([0; 12]);
    hdlr.extend(b"SubtitleHandler\0");
    let hdlr = full_box(b"hdlr", 0, 0, &hdlr);

    let nmhd = full_box(b"nmhd", 0, 0, &[]);
    let url = full_box(b"url ", 0, 1, &[]); // in this file
    let mut dref = 1u32.to_be_bytes().to_vec();
    dref.extend(url);
    let dinf = boxed(b"dinf", &full_box(b"dref", 0, 0, &dref));

    // The sample description: white, centred along the bottom.
    let mut entry = vec![0; 6];
    entry.extend(1u16.to_be_bytes()); // data reference
    entry.extend(0u32.to_be_bytes()); // display flags
    entry.push(1); // centred
    entry.push(0xff); // at the bottom
    entry.extend([0, 0, 0, 0]); // no background
    for side in [0i16, 0, box_height as i16, width as i16] {
        entry.extend(side.to_be_bytes());
    }
    entry.extend(0u16.to_be_bytes());
    entry.extend(0u16.to_be_bytes());
    entry.extend(1u16.to_be_bytes()); // font
    entry.push(0); // plain
    entry.push((height / 20).clamp(12, 255) as u8);
    entry.extend([0xff, 0xff, 0xff, 0xff]);
    let mut fonts = 1u16.to_be_bytes().to_vec();
    fonts.extend(1u16.to_be_bytes());
    fonts.push(10);
    fonts.extend(b"Sans-Serif");
    entry.extend(boxed(b"ftab", &fonts));
    let mut stsd = 1u32.to_be_bytes().to_vec();
    stsd.extend(boxed(b"tx3g", &entry));
    let stsd = full_box(b"stsd", 0, 0, &stsd);

    // Each sample's duration, in runs of the same.
    let mut runs: Vec<(u32, u32)> = Vec::new();
    let mut previous = 0u32;
    for (_, end, _) in samples {
        let end = (end * f64::from(TIMESCALE)).round() as u32;
        let duration = end.saturating_sub(previous);
        previous = end;
        match runs.last_mut() {
            Some((count, last)) if *last == duration => *count += 1,
            _ => runs.push((1, duration)),
        }
    }
    let mut stts = (runs.len() as u32).to_be_bytes().to_vec();
    for (count, duration) in runs {
        stts.extend(count.to_be_bytes());
        stts.extend(duration.to_be_bytes());
    }
    let stts = full_box(b"stts", 0, 0, &stts);
    let mut stsc = 1u32.to_be_bytes().to_vec();
    stsc.extend(1u32.to_be_bytes());
    stsc.extend((samples.len() as u32).to_be_bytes());
    stsc.extend(1u32.to_be_bytes());
    let stsc = full_box(b"stsc", 0, 0, &stsc);
    let mut stsz = 0u32.to_be_bytes().to_vec();
    stsz.extend((samples.len() as u32).to_be_bytes());
    for (_, _, text) in samples {
        stsz.extend((sample_data(text).len() as u32).to_be_bytes());
    }
    let stsz = full_box(b"stsz", 0, 0, &stsz);
    let chunks = match u32::try_from(offset) {
        Ok(offset) => {
            let mut stco = 1u32.to_be_bytes().to_vec();
            stco.extend(offset.to_be_bytes());
            full_box(b"stco", 0, 0, &stco)
        }
        Err(_) => {
            let mut co64 = 1u32.to_be_bytes().to_vec();
            co64.extend(offset.to_be_bytes());
            full_box(b"co64", 0, 0, &co64)
        }
    };
    let stbl = boxed(b"stbl", &[stsd, stts, stsc, stsz, chunks].concat());
    let minf = boxed(b"minf", &[nmhd, dinf, stbl].concat());
    let mdia = boxed(b"mdia", &[mdhd, hdlr, minf].concat());
    boxed(b"trak", &[tkhd, mdia].concat())
}

/// The film's user data, `old` (its boxes), with the program that wrote the
/// film in iTunes' metadata, where ffprobe and MediaInfo look for it: the
/// encoding tool (©too). What's there stays, a name there already too.
fn user_data(old: &[u8]) -> Result<Vec<u8>, String> {
    let mut others = Vec::new();
    let mut meta: &[u8] = &[];
    for (kind, start, end) in children(old)? {
        if &kind == b"meta" && meta.is_empty() {
            // After its version and flags.
            meta = old.get(start + 12..end).unwrap_or_default();
        } else {
            others.extend(&old[start..end]);
        }
    }
    let (mut handler, mut items, mut rest) = (None, Vec::new(), Vec::new());
    for (kind, start, end) in children(meta)? {
        match &kind {
            b"hdlr" if handler.is_none() => handler = Some(&meta[start..end]),
            b"ilst" if items.is_empty() => items = meta[start + 8..end].to_vec(),
            _ => rest.extend(&meta[start..end]),
        }
    }
    // Metadata of another kind than iTunes': left as it is.
    if handler.is_some_and(|hdlr| hdlr.get(16..20) != Some(b"mdir")) {
        return Ok(boxed(b"udta", old));
    }
    if !children(&items)?
        .iter()
        .any(|(kind, _, _)| kind == b"\xa9too")
    {
        // UTF-8 (type 1), in no locale.
        let mut value = 1u32.to_be_bytes().to_vec();
        value.extend(0u32.to_be_bytes());
        value.extend(WRITING_APP.as_bytes());
        items.extend(boxed(b"\xa9too", &boxed(b"data", &value)));
    }
    // iTunes' handler: no predefined value, the type and its maker, two
    // reserved words and an empty name.
    let hdlr = handler.map_or_else(
        || {
            let mut handler = vec![0u8; 4];
            handler.extend(b"mdirappl");
            handler.extend([0u8; 9]);
            full_box(b"hdlr", 0, 0, &handler)
        },
        <[u8]>::to_vec,
    );
    let meta = full_box(
        b"meta",
        0,
        0,
        &[hdlr, rest, boxed(b"ilst", &items)].concat(),
    );
    Ok(boxed(b"udta", &[others, meta].concat()))
}

/// Finishes the MP4 at `path`: its subtitle tracks, for a picture of
/// `size`, and the program that wrote it.
pub fn finish(path: &Path, tracks: &[SubtitleTrack], size: (u32, u32)) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Couldn't finish the file: {error}");
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(failed)?;
    let length = file.metadata().map_err(failed)?.len();
    // The top-level boxes, by their headers alone: the film's data is long.
    let mut at = 0u64;
    let mut moov = None;
    while at + 8 <= length {
        let mut header = [0u8; 16];
        file.seek(SeekFrom::Start(at)).map_err(failed)?;
        file.read_exact(&mut header[..8]).map_err(failed)?;
        let mut size = u64::from(u32::from_be_bytes(
            header[..4].try_into().unwrap_or_default(),
        ));
        if size == 1 {
            file.read_exact(&mut header[8..]).map_err(failed)?;
            size = u64::from_be_bytes(header[8..].try_into().unwrap_or_default());
        } else if size == 0 {
            size = length - at;
        }
        if size < 8 || at + size > length {
            return Err("the film isn't a whole MP4".into());
        }
        if &header[4..8] == b"moov" {
            moov = Some((at, size));
        }
        at += size;
    }
    let (moov_at, moov_size) = moov.ok_or("the film has no index")?;
    // Where the new data and index go: in the old index's place at the end,
    // or after everything.
    let is_last = moov_at + moov_size == length;
    let write_at = if is_last { moov_at } else { length };
    let mut index = vec![0u8; moov_size as usize];
    file.seek(SeekFrom::Start(moov_at)).map_err(failed)?;
    file.read_exact(&mut index).map_err(failed)?;
    let header_length = if u32::from_be_bytes(index[..4].try_into().unwrap_or_default()) == 1 {
        16
    } else {
        8
    };
    let contents = &index[header_length..];
    let boxes = children(contents)?;
    let (_, mvhd_start, mvhd_end) = *boxes
        .iter()
        .find(|(kind, _, _)| kind == b"mvhd")
        .ok_or("the film has no movie header")?;
    let mut mvhd = contents[mvhd_start..mvhd_end].to_vec();
    let (duration, next_id_at) = movie_header(&mvhd)?;
    let first_id = u32::from_be_bytes(
        mvhd[next_id_at..next_id_at + 4]
            .try_into()
            .unwrap_or_default(),
    );

    // The lines, in an mdat where the index was.
    let all: Vec<Vec<(f64, f64, String)>> =
        tracks.iter().map(|track| samples(&track.cues)).collect();
    let data: Vec<u8> = all
        .iter()
        .flatten()
        .flat_map(|(_, _, text)| sample_data(text))
        .collect();
    let mdat = if data.is_empty() {
        Vec::new()
    } else {
        boxed(b"mdat", &data)
    };
    let mut offset = write_at + 8;
    let mut traks = Vec::new();
    for (index, samples) in all.iter().enumerate() {
        let id = first_id + index as u32;
        traks.extend(track(id, duration, samples, offset, size));
        offset += samples
            .iter()
            .map(|(_, _, text)| sample_data(text).len() as u64)
            .sum::<u64>();
    }
    let next_id = first_id + tracks.len() as u32;
    mvhd[next_id_at..next_id_at + 4].copy_from_slice(&next_id.to_be_bytes());
    let mut rest = Vec::new();
    let mut old_user_data: &[u8] = &[];
    for &(kind, start, end) in &boxes {
        match &kind {
            b"mvhd" => rest.extend(&mvhd),
            b"udta" => old_user_data = &contents[start + 8..end],
            _ => rest.extend(&contents[start..end]),
        }
    }
    rest.extend(traks);
    rest.extend(user_data(old_user_data)?);
    let new_index = boxed(b"moov", &rest);

    if is_last {
        file.set_len(moov_at).map_err(failed)?;
    } else {
        // The old index, kept as free space where it was.
        let type_at = moov_at + 4;
        file.seek(SeekFrom::Start(type_at)).map_err(failed)?;
        file.write_all(b"free").map_err(failed)?;
    }
    file.seek(SeekFrom::Start(write_at)).map_err(failed)?;
    file.write_all(&mdat).map_err(failed)?;
    file.write_all(&new_index).map_err(failed)?;
    file.sync_all().map_err(failed)
}

/// The subtitle tracks of an MP4 as this module writes them: each sample's
/// start, end and text, track by track.
#[cfg(test)]
pub fn read_tracks(path: &Path) -> Vec<Vec<(f64, f64, String)>> {
    let file = std::fs::read(path).unwrap();
    let top = children(&file).unwrap();
    let (_, moov_start, moov_end) = *top.iter().find(|(kind, _, _)| kind == b"moov").unwrap();
    let find = |data: &[u8], kind: &[u8; 4]| -> Option<(usize, usize)> {
        children(data)
            .ok()?
            .into_iter()
            .find(|(found, _, _)| found == kind)
            .map(|(_, start, end)| (start + 8, end))
    };
    let number = |data: &[u8], at: usize| u32::from_be_bytes(data[at..at + 4].try_into().unwrap());
    let mut tracks = Vec::new();
    let moov = &file[moov_start + 8..moov_end];
    for (kind, start, end) in children(moov).unwrap() {
        if &kind != b"trak" {
            continue;
        }
        let trak = &moov[start + 8..end];
        let Some((mdia_start, mdia_end)) = find(trak, b"mdia") else {
            continue;
        };
        let mdia = &trak[mdia_start..mdia_end];
        let (hdlr_start, _) = find(mdia, b"hdlr").unwrap();
        if &mdia[hdlr_start + 8..hdlr_start + 12] != b"sbtl" {
            continue;
        }
        let (mdhd_start, _) = find(mdia, b"mdhd").unwrap();
        let timescale = f64::from(number(mdia, mdhd_start + 12));
        let (minf_start, minf_end) = find(mdia, b"minf").unwrap();
        let minf = &mdia[minf_start..minf_end];
        let (stbl_start, stbl_end) = find(minf, b"stbl").unwrap();
        let stbl = &minf[stbl_start..stbl_end];
        let (stts, _) = find(stbl, b"stts").unwrap();
        let mut durations = Vec::new();
        for run in 0..number(stbl, stts + 4) as usize {
            let at = stts + 8 + run * 8;
            for _ in 0..number(stbl, at) {
                durations.push(number(stbl, at + 4));
            }
        }
        let (stsz, _) = find(stbl, b"stsz").unwrap();
        let count = number(stbl, stsz + 8) as usize;
        let sizes: Vec<usize> = (0..count)
            .map(|i| number(stbl, stsz + 12 + i * 4) as usize)
            .collect();
        let (stco, _) = find(stbl, b"stco").unwrap();
        let mut at = number(stbl, stco + 8) as usize;
        let (mut time, mut samples) = (0u32, Vec::new());
        for (size, duration) in sizes.into_iter().zip(durations) {
            let length = usize::from(u16::from_be_bytes([file[at], file[at + 1]]));
            let text = String::from_utf8(file[at + 2..at + 2 + length].to_vec()).unwrap();
            samples.push((
                f64::from(time) / timescale,
                f64::from(time + duration) / timescale,
                text,
            ));
            time += duration;
            at += size;
        }
        tracks.push(samples);
    }
    tracks
}

#[cfg(test)]
mod tests {
    use super::{SubtitleCue, samples};

    #[test]
    fn fills_the_stretches_between_lines() {
        let cue = |start, end, text: &str| SubtitleCue {
            start,
            end,
            text: text.into(),
        };
        let found = samples(&[cue(0.7, 0.9, "two"), cue(0.2, 0.5, "one")]);
        assert_eq!(
            found,
            [
                (0.0, 0.2, String::new()),
                (0.2, 0.5, "one".into()),
                (0.5, 0.7, String::new()),
                (0.7, 0.9, "two".into()),
            ]
        );
    }
}
