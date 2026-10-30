// Timing subtitles to the speech (docs/PLAN.md, step 10): text with no
// times matched to the words Whisper heard (auto-sync), and subtitles that
// are early, late or drift lined up with when someone speaks, which works for
// a translation too, since it looks at when, not at what.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::Cue;
use crate::timing::Retime;

/// A word heard, and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// A stretch of time, in seconds: someone speaking.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

/// A word as it's compared: lowercase letters and digits only.
fn normalize(word: &str) -> String {
    word.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn words_of(text: &str) -> impl Iterator<Item = String> + '_ {
    crate::markup::plain(text)
        .split(|character: char| character.is_whitespace() || character == '-' || character == '—')
        .map(normalize)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .into_iter()
}

/// How alike two words are: 2 the same, 1 nearly (a letter or so apart, as a
/// transcription mishears), else -1.
fn likeness(a: &str, b: &str) -> i32 {
    if a == b {
        return 2;
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let longest = a.len().max(b.len());
    if longest < 4 {
        return -1;
    }
    // Levenshtein distance, a row at a time.
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let substituted = previous + usize::from(x != y);
            previous = row[j + 1];
            row[j + 1] = substituted.min(row[j] + 1).min(previous + 1);
        }
    }
    if row[b.len()] * 3 <= longest { 1 } else { -1 }
}

// Stretches between anchors longer than this, either side multiplied, are
// matched in proportion rather than word by word.
const MAX_CELLS: usize = 4_000_000;

/// Each run of three words, and where it starts if it's found only once.
fn trigrams(words: &[String]) -> HashMap<(&str, &str, &str), Option<usize>> {
    let mut found = HashMap::new();
    for (at, window) in words.windows(3).enumerate() {
        found
            .entry((window[0].as_str(), window[1].as_str(), window[2].as_str()))
            .and_modify(|seen| *seen = None)
            .or_insert(Some(at));
    }
    found
}

/// For each of `script`'s words, the one of `heard` it is, if any: in order,
/// as both are. Anchored on runs of three words found once in each, then
/// word by word between them.
fn align(script: &[String], heard: &[String]) -> Vec<Option<usize>> {
    let mut matched = vec![None; script.len()];
    let (in_script, in_heard) = (trigrams(script), trigrams(heard));
    let mut pairs: Vec<(usize, usize)> = in_script
        .iter()
        .filter_map(|(key, at)| {
            Some((at.as_ref().copied()?, in_heard.get(key)?.as_ref().copied()?))
        })
        .collect();
    pairs.sort_unstable();
    // The longest run of pairs in order on both sides (patience sorting).
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![usize::MAX; pairs.len()];
    for (index, &(_, heard_at)) in pairs.iter().enumerate() {
        let place = tails.partition_point(|&tail| pairs[tail].1 < heard_at);
        if place > 0 {
            previous[index] = tails[place - 1];
        }
        if place == tails.len() {
            tails.push(index);
        } else {
            tails[place] = index;
        }
    }
    let mut anchors = Vec::new();
    let mut at = tails.last().copied();
    while let Some(index) = at {
        anchors.push(pairs[index]);
        at = (previous[index] != usize::MAX).then_some(previous[index]);
    }
    anchors.reverse();
    // Each anchor is three words long; the stretches between are aligned.
    let (mut script_at, mut heard_at) = (0, 0);
    for (script_anchor, heard_anchor) in anchors.into_iter().chain([(script.len(), heard.len())]) {
        if script_anchor < script_at || heard_anchor < heard_at {
            continue;
        }
        align_stretch(
            script,
            heard,
            (script_at, script_anchor),
            (heard_at, heard_anchor),
            &mut matched,
        );
        for offset in 0..3 {
            if script_anchor + offset < script.len() && heard_anchor + offset < heard.len() {
                matched[script_anchor + offset] = Some(heard_anchor + offset);
            }
        }
        script_at = script_anchor + 3;
        heard_at = heard_anchor + 3;
    }
    matched
}

/// Words `script[a..b]` matched to `heard[c..d]`: Needleman-Wunsch, or in
/// proportion if the stretch is too long for it.
fn align_stretch(
    script: &[String],
    heard: &[String],
    (script_from, script_to): (usize, usize),
    (heard_from, heard_to): (usize, usize),
    matched: &mut [Option<usize>],
) {
    let (rows, columns) = (script_to - script_from, heard_to - heard_from);
    if rows == 0 || columns == 0 {
        return;
    }
    if rows * columns > MAX_CELLS {
        for row in 0..rows {
            matched[script_from + row] = Some(heard_from + row * columns / rows);
        }
        return;
    }
    const GAP: i32 = -1;
    let width = columns + 1;
    let mut score = vec![0i32; (rows + 1) * width];
    for row in 0..=rows {
        score[row * width] = row as i32 * GAP;
    }
    for (column, cell) in score.iter_mut().take(width).enumerate() {
        *cell = column as i32 * GAP;
    }
    for row in 1..=rows {
        for column in 1..=columns {
            let pair = likeness(
                &script[script_from + row - 1],
                &heard[heard_from + column - 1],
            );
            score[row * width + column] = (score[(row - 1) * width + column - 1] + pair)
                .max(score[(row - 1) * width + column] + GAP)
                .max(score[row * width + column - 1] + GAP);
        }
    }
    let (mut row, mut column) = (rows, columns);
    while row > 0 && column > 0 {
        let here = score[row * width + column];
        let pair = likeness(
            &script[script_from + row - 1],
            &heard[heard_from + column - 1],
        );
        if pair > 0 && here == score[(row - 1) * width + column - 1] + pair {
            matched[script_from + row - 1] = Some(heard_from + column - 1);
            row -= 1;
            column -= 1;
        } else if here == score[(row - 1) * width + column] + GAP {
            row -= 1;
        } else {
            column -= 1;
        }
    }
}

/// Lines of text timed to the words heard: each from its first word heard to
/// its last; a line none of whose words were heard placed between its
/// neighbours, in proportion to its length. None if no word was matched.
pub fn time_lines(lines: &[String], heard: &[Word]) -> Option<Vec<Cue>> {
    let mut script = Vec::new();
    let mut line_of = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        for word in words_of(line) {
            script.push(word);
            line_of.push(index);
        }
    }
    let heard_words: Vec<String> = heard.iter().map(|word| normalize(&word.text)).collect();
    let matched = align(&script, &heard_words);
    let mut times: Vec<Option<(f64, f64)>> = vec![None; lines.len()];
    for (word, heard_at) in matched.iter().enumerate() {
        let Some(heard_at) = *heard_at else {
            continue;
        };
        let (start, end) = (heard[heard_at].start, heard[heard_at].end);
        let time = &mut times[line_of[word]];
        *time = Some(match *time {
            Some((first, last)) => (first.min(start), last.max(end)),
            None => (start, end),
        });
    }
    if times.iter().all(Option::is_none) {
        return None;
    }
    // The lines not heard, between the ones that were.
    let mut index = 0;
    while index < lines.len() {
        if times[index].is_some() {
            index += 1;
            continue;
        }
        let gap_end = (index..lines.len())
            .find(|&at| times[at].is_some())
            .unwrap_or(lines.len());
        let from = if index == 0 {
            times[gap_end]
                .map_or(0.0, |(start, _)| start - 2.0 * gap_end as f64)
                .max(0.0)
        } else {
            times[index - 1].map_or(0.0, |(_, end)| end)
        };
        let to = times
            .get(gap_end)
            .copied()
            .flatten()
            .map_or(from + 2.0 * (gap_end - index) as f64, |(start, _)| start);
        let lengths: Vec<f64> = (index..gap_end)
            .map(|at| crate::markup::plain(&lines[at]).chars().count().max(1) as f64)
            .collect();
        let total: f64 = lengths.iter().sum();
        let mut start = from;
        for (offset, length) in lengths.iter().enumerate() {
            let end = start + (to - from) * length / total;
            times[index + offset] = Some((start, end));
            start = end;
        }
        index = gap_end;
    }
    Some(
        lines
            .iter()
            .zip(times)
            .map(|(line, time)| {
                let (start, end) = time.unwrap_or_default();
                Cue {
                    start,
                    end,
                    text: line.clone(),
                    style: None,
                }
            })
            .collect(),
    )
}

/// How subtitles that are early, late or drift line up with the speech.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub retime: Retime,
    /// How much of the lines' time someone is speaking, before and after.
    pub overlap_before: f64,
    pub overlap_after: f64,
}

/// Subtitles' times and the speech's on a grid of `step` seconds: whether
/// each slot is covered.
fn grid(spans: impl Iterator<Item = Span>, step: f64, slots: usize) -> Vec<f32> {
    let mut grid = vec![0f32; slots];
    for span in spans {
        let from = (span.start / step).floor().max(0.0) as usize;
        let to = ((span.end / step).ceil().max(0.0) as usize).min(slots);
        for slot in grid.iter_mut().take(to).skip(from.min(to)) {
            *slot = 1.0;
        }
    }
    grid
}

/// The shift, among those from `low` to `high` seconds in `step`s, that puts
/// the most of the lines over speech.
fn best_shift(cues: &[Span], speech: &[Span], step: f64, (low, high): (f64, f64)) -> (f64, f64) {
    let end = cues
        .iter()
        .chain(speech)
        .map(|span| span.end)
        .fold(0.0, f64::max)
        + high.abs().max(low.abs());
    let slots = (end / step).ceil() as usize + 1;
    let speech = grid(speech.iter().copied(), step, slots);
    let lines = grid(cues.iter().copied(), step, slots);
    let mut best: (f64, f64) = (0.0, f64::NEG_INFINITY);
    let (first, last) = ((low / step).round() as i64, (high / step).round() as i64);
    for shift in first..=last {
        let mut overlap = 0.0f64;
        for (slot, &covered) in lines.iter().enumerate() {
            if covered == 0.0 {
                continue;
            }
            let at = slot as i64 + shift;
            if (0..slots as i64).contains(&at) {
                overlap += f64::from(speech[at as usize]);
            }
        }
        // Of equals, the smallest shift.
        let seconds = shift as f64 * step;
        if overlap > best.1 || (overlap == best.1 && seconds.abs() < best.0.abs()) {
            best = (seconds, overlap);
        }
    }
    best
}

/// The share of the lines' time over speech.
fn overlap(cues: &[Span], speech: &[Span]) -> f64 {
    let total: f64 = cues.iter().map(|cue| (cue.end - cue.start).max(0.0)).sum();
    if total == 0.0 {
        return 0.0;
    }
    let mut covered = 0.0;
    for cue in cues {
        for spoken in speech {
            covered += (cue.end.min(spoken.end) - cue.start.max(spoken.start)).max(0.0);
        }
    }
    (covered / total).min(1.0)
}

// How far off subtitles are looked for, and how much they may drift.
const MAX_SHIFT: f64 = 120.0;
const MAX_DRIFT: f64 = 0.1;

// The frame rates films are made and shown at: subtitles timed to one and
// played at another drift by their ratio, the commonest drift there is.
const FRAME_RATES: [f64; 5] = [24000.0 / 1001.0, 24.0, 25.0, 30000.0 / 1001.0, 30.0];

/// The scales to try: none, and each ratio of two frame rates within reach.
fn scales() -> Vec<f64> {
    let mut scales = vec![1.0];
    for from in FRAME_RATES {
        for to in FRAME_RATES {
            let scale = from / to;
            if from != to && (scale - 1.0).abs() <= MAX_DRIFT {
                scales.push(scale);
            }
        }
    }
    scales
}

fn retimed(spans: &[Span], retime: Retime) -> Vec<Span> {
    spans
        .iter()
        .map(|span| Span {
            start: retime.apply(span.start),
            end: retime.apply(span.end),
        })
        .collect()
}

/// The shift and drift that line the subtitles up with the speech: of the
/// frame rates' ratios, the one that does it best with a shift; then the
/// shift for each half, the two making a straight line of what drift is
/// left. None with nothing to go on.
pub fn fit(cues: &[Cue], speech: &[Span]) -> Option<Fit> {
    if cues.len() < 2 || speech.is_empty() {
        return None;
    }
    let spans: Vec<Span> = cues
        .iter()
        .map(|cue| Span {
            start: cue.start,
            end: cue.end,
        })
        .collect();
    // No scale first: another must do better to be taken.
    let mut best = (1.0, 0.0, f64::NEG_INFINITY);
    for scale in scales() {
        let scaled = retimed(&spans, Retime { scale, offset: 0.0 });
        let (shift, score) = best_shift(&scaled, speech, 0.5, (-MAX_SHIFT, MAX_SHIFT));
        if score > best.2 {
            best = (scale, shift, score);
        }
    }
    let (scale, coarse, _) = best;
    let scaled = retimed(&spans, Retime { scale, offset: 0.0 });
    let (shift, _) = best_shift(&scaled, speech, 0.05, (coarse - 1.0, coarse + 1.0));
    let half = scaled.len() / 2;
    let (first, second) = scaled.split_at(half);
    let middle = |spans: &[Span]| {
        spans
            .iter()
            .map(|span| (span.start + span.end) / 2.0)
            .sum::<f64>()
            / spans.len() as f64
    };
    let reach = (shift - 10.0, shift + 10.0);
    let (first_shift, _) = best_shift(first, speech, 0.05, reach);
    let (second_shift, _) = best_shift(second, speech, 0.05, reach);
    let (first_at, second_at) = (middle(first), middle(second));
    let slope = (second_shift - first_shift) / (second_at - first_at).max(1.0);
    let retime = if slope.abs() <= MAX_DRIFT && slope.abs() > 1e-4 {
        Retime {
            scale: scale * (1.0 + slope),
            offset: first_shift - slope * first_at,
        }
    } else {
        Retime {
            scale,
            offset: shift,
        }
    };
    Some(Fit {
        retime,
        overlap_before: overlap(&spans, speech),
        overlap_after: overlap(&retimed(&spans, retime), speech),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heard(words: &[(&str, f64, f64)]) -> Vec<Word> {
        words
            .iter()
            .map(|&(text, start, end)| Word {
                text: text.to_owned(),
                start,
                end,
            })
            .collect()
    }

    #[test]
    fn times_lines_to_the_words_heard() {
        let lines: Vec<String> = [
            "Hello there!",
            "How are you, Anna?",
            "(music)",
            "I'm fine, thanks.",
        ]
        .map(String::from)
        .into();
        // Misheard: "Hallo", "Ana"; the music line has no words heard.
        let words = heard(&[
            (" Hallo", 1.0, 1.4),
            (" there.", 1.5, 1.9),
            (" How", 3.0, 3.2),
            (" are", 3.2, 3.4),
            (" you", 3.4, 3.6),
            (" Ana?", 3.7, 4.2),
            (" I'm", 8.0, 8.3),
            (" fine,", 8.3, 8.7),
            (" thanks.", 8.8, 9.4),
        ]);
        let cues = time_lines(&lines, &words).unwrap();
        let times: Vec<(f64, f64)> = cues.iter().map(|cue| (cue.start, cue.end)).collect();
        assert_eq!(times[0], (1.0, 1.9));
        assert_eq!(times[1], (3.0, 4.2));
        assert_eq!(times[3], (8.0, 9.4));
        // Between its neighbours.
        assert_eq!(times[2], (4.2, 8.0));
        assert_eq!(cues[1].text, "How are you, Anna?");
        assert!(time_lines(&lines, &heard(&[("zebra", 0.0, 1.0)])).is_none());
    }

    #[test]
    fn aligns_a_long_script_through_its_anchors() {
        // 3000 words, a few dropped and changed by the transcription.
        let script: Vec<String> = (0..3000).map(|i| format!("w{}", i * 7919 % 1000)).collect();
        let mut words = Vec::new();
        for (i, word) in script.iter().enumerate() {
            if i % 97 == 5 {
                continue;
            }
            let text = if i % 89 == 3 {
                "uh".to_owned()
            } else {
                word.clone()
            };
            words.push(Word {
                text,
                start: i as f64 * 0.4,
                end: i as f64 * 0.4 + 0.3,
            });
        }
        let lines: Vec<String> = script.chunks(6).map(|chunk| chunk.join(" ")).collect();
        let cues = time_lines(&lines, &words).unwrap();
        for (index, cue) in cues.iter().enumerate() {
            let expected = index as f64 * 6.0 * 0.4;
            assert!((cue.start - expected).abs() < 0.41, "line {index}: {cue:?}");
        }
    }

    /// Spans of speech, of 1 to 4 s with gaps of 0.5 to 3, over `length` s.
    fn speech(length: f64) -> Vec<Span> {
        let mut spans = Vec::new();
        let (mut at, mut seed) = (2.0, 12345u64);
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64
        };
        while at < length {
            let end = at + 1.0 + 3.0 * next();
            spans.push(Span { start: at, end });
            at = end + 0.5 + 2.5 * next();
        }
        spans
    }

    #[test]
    fn finds_how_late_subtitles_are_and_how_they_drift() {
        let speech = speech(1800.0);
        // Subtitles timed to a film 4% slower, and 3.2 s late.
        let truth = Retime {
            scale: 1.04,
            offset: 3.2,
        };
        let cues: Vec<Cue> = speech
            .iter()
            .map(|span| Cue {
                start: truth.apply(span.start),
                end: truth.apply(span.end),
                text: "line".into(),
                style: None,
            })
            .collect();
        let fit = fit(&cues, &speech).unwrap();
        for time in [10.0, 900.0, 1800.0] {
            let error = fit.retime.apply(truth.apply(time)) - time;
            assert!(error.abs() < 0.15, "{error} s off at {time}: {fit:?}");
        }
        assert!(
            fit.overlap_after > 0.95 && fit.overlap_after > fit.overlap_before + 0.3,
            "{fit:?}"
        );
    }

    #[test]
    fn lines_up_a_translation_by_when_people_speak() {
        let speech = speech(600.0);
        // Each line two of the spoken spans, 2.5 s early.
        let cues: Vec<Cue> = speech
            .chunks(2)
            .map(|pair| Cue {
                start: pair[0].start - 2.5,
                end: pair[pair.len() - 1].end - 2.5,
                text: "traduction".into(),
                style: None,
            })
            .collect();
        let fit = fit(&cues, &speech).unwrap();
        assert!((fit.retime.apply(100.0) - 102.5).abs() < 0.15, "{fit:?}");
    }
}
