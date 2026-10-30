// Retiming, as Jubler's tools do it, written anew: shifting, stretching,
// another frame rate, two-point sync, and the fixes for lines that overlap or
// show too briefly or too long to read.

use serde::{Deserialize, Serialize};

use crate::Cue;
use crate::markup::plain;

/// A straight line from times as they are to times as they should be:
/// `scale * time + offset`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Retime {
    pub scale: f64,
    pub offset: f64,
}

impl Retime {
    /// Everything later by `seconds` (earlier if negative).
    pub fn shift(seconds: f64) -> Self {
        Self {
            scale: 1.0,
            offset: seconds,
        }
    }

    /// Subtitles timed to a film at one frame rate, for it at another: from
    /// 23.976 to 25, the film plays faster, and the lines come sooner.
    pub fn frame_rate(from: f64, to: f64) -> Self {
        Self {
            scale: from / to,
            offset: 0.0,
        }
    }

    /// Jubler's two-point sync: two times as they are and as they should be,
    /// every other time moved in proportion. None if the two are one.
    pub fn two_points((from_a, to_a): (f64, f64), (from_b, to_b): (f64, f64)) -> Option<Self> {
        let span = from_b - from_a;
        if span.abs() < 1e-6 {
            return None;
        }
        let scale = (to_b - to_a) / span;
        Some(Self {
            scale,
            offset: to_a - scale * from_a,
        })
    }

    pub fn apply(self, time: f64) -> f64 {
        (self.scale * time + self.offset).max(0.0)
    }
}

/// The cues retimed; none starts before zero.
pub fn retime(cues: &mut [Cue], retime: Retime) {
    for cue in cues {
        cue.start = retime.apply(cue.start);
        cue.end = retime.apply(cue.end).max(cue.start);
    }
}

/// How fast a cue asks to be read, in characters a second.
pub fn reading_speed(cue: &Cue) -> f64 {
    let characters = plain(&cue.text)
        .chars()
        .filter(|character| *character != '\n')
        .count();
    characters as f64 / (cue.end - cue.start).max(0.001)
}

/// Each cue ending at least `gap` before the next starts, by ending sooner:
/// how many were changed. The cues in order of their start.
pub fn fix_overlaps(cues: &mut [Cue], gap: f64) -> usize {
    let mut changed = 0;
    for index in 1..cues.len() {
        let latest_end = cues[index].start - gap;
        let cue = &mut cues[index - 1];
        if cue.end > latest_end {
            cue.end = latest_end.max(cue.start);
            changed += 1;
        }
    }
    changed
}

/// What a line's time on screen should be.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationRules {
    /// In seconds.
    pub min: f64,
    pub max: f64,
    /// The fastest a reader should be asked to read.
    pub characters_per_second: f64,
    /// Kept between one line and the next.
    pub gap: f64,
}

impl Default for DurationRules {
    /// Netflix's for adults: 5/6 s to 7 s, 20 characters a second, and two
    /// frames at 24 apart.
    fn default() -> Self {
        Self {
            min: 5.0 / 6.0,
            max: 7.0,
            characters_per_second: 20.0,
            gap: 2.0 / 24.0,
        }
    }
}

/// Lines too brief to read made longer, as far as the next one allows, and
/// lines that stay too long made shorter: how many were changed. The cues in
/// order of their start.
pub fn fix_durations(cues: &mut [Cue], rules: DurationRules) -> usize {
    let mut changed = 0;
    for index in 0..cues.len() {
        let next_start = cues.get(index + 1).map_or(f64::INFINITY, |next| next.start);
        let cue = &mut cues[index];
        let characters = plain(&cue.text).chars().filter(|c| *c != '\n').count() as f64;
        let wanted = (characters / rules.characters_per_second)
            .max(rules.min)
            .min(rules.max);
        let duration = cue.end - cue.start;
        let end = if duration < wanted {
            (cue.start + wanted)
                .min(next_start - rules.gap)
                .max(cue.end)
        } else if duration > rules.max {
            cue.start + rules.max
        } else {
            cue.end
        };
        if (end - cue.end).abs() > 1e-9 {
            cue.end = end;
            changed += 1;
        }
    }
    changed
}

/// A cue in two at a character of its text, its time shared in proportion
/// to their lengths. None if that leaves one side empty.
pub fn split(cue: &Cue, at: usize) -> Option<(Cue, Cue)> {
    let at = cue.text.char_indices().nth(at).map(|(byte, _)| byte)?;
    let (first, second) = cue.text.split_at(at);
    let (first, second) = (first.trim_end(), second.trim_start());
    if plain(first).trim().is_empty() || plain(second).trim().is_empty() {
        return None;
    }
    let share = plain(first).chars().count() as f64
        / (plain(first).chars().count() + plain(second).chars().count()) as f64;
    let middle = cue.start + (cue.end - cue.start) * share;
    Some((
        Cue {
            end: middle,
            text: first.to_owned(),
            ..cue.clone()
        },
        Cue {
            start: middle,
            text: second.to_owned(),
            ..cue.clone()
        },
    ))
}

/// Cues as one: from the first's start to the last's end, their lines one
/// after another. None for none.
pub fn join(cues: &[Cue]) -> Option<Cue> {
    let first = cues.first()?;
    Some(Cue {
        start: cues
            .iter()
            .map(|cue| cue.start)
            .fold(f64::INFINITY, f64::min),
        end: cues
            .iter()
            .map(|cue| cue.end)
            .fold(f64::NEG_INFINITY, f64::max),
        text: cues
            .iter()
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        style: first.style.clone(),
    })
}

/// A time moved to the nearest of `edges` (where speech starts or ends, a
/// cut) if one is within `reach` seconds: the magnet in MagnetCut.
pub fn snap(time: f64, edges: &[f64], reach: f64) -> f64 {
    edges
        .iter()
        .copied()
        .filter(|edge| (edge - time).abs() <= reach)
        .min_by(|a, b| (a - time).abs().total_cmp(&(b - time).abs()))
        .unwrap_or(time)
}

/// Each line's start moved to the nearest of `starts` and its end to the
/// nearest of `ends` within `reach` seconds (where speech starts and ends, and
/// cuts, in both), keeping it at least `shortest` long: how many moved.
pub fn snap_edges(
    cues: &mut [Cue],
    starts: &[f64],
    ends: &[f64],
    reach: f64,
    shortest: f64,
) -> usize {
    let mut moved = 0;
    for cue in cues {
        let start = snap(cue.start, starts, reach);
        let end = snap(cue.end, ends, reach);
        if end - start < shortest || (start == cue.start && end == cue.end) {
            continue;
        }
        cue.start = start;
        cue.end = end;
        moved += 1;
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(start: f64, end: f64, text: &str) -> Cue {
        Cue {
            start,
            end,
            text: text.to_owned(),
            style: None,
        }
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn shifts_and_converts_frame_rates() {
        let mut cues = vec![cue(1.0, 2.0, "a"), cue(0.2, 0.5, "b")];
        retime(&mut cues, Retime::shift(-0.5));
        assert_eq!((cues[0].start, cues[0].end), (0.5, 1.5));
        // None before zero.
        assert_eq!((cues[1].start, cues[1].end), (0.0, 0.0));
        let to_pal = Retime::frame_rate(24000.0 / 1001.0, 25.0);
        assert!(near(to_pal.apply(1001.0), 960.0));
    }

    #[test]
    fn syncs_on_two_points() {
        // A line at 10 s should be at 12, one at 110 at 117: 5% slow, 1.5 s late.
        let retime = Retime::two_points((10.0, 12.0), (110.0, 117.0)).unwrap();
        assert!(near(retime.apply(10.0), 12.0) && near(retime.apply(110.0), 117.0));
        assert!(near(retime.apply(60.0), 64.5));
        assert_eq!(Retime::two_points((5.0, 1.0), (5.0, 2.0)), None);
    }

    #[test]
    fn measures_reading_speed() {
        assert!(near(
            reading_speed(&cue(0.0, 2.0, "<i>Hello</i>\nworld")),
            5.0
        ));
    }

    #[test]
    fn pulls_back_ends_that_overlap() {
        let mut cues = vec![cue(0.0, 2.5, "a"), cue(2.0, 3.0, "b"), cue(3.5, 4.0, "c")];
        assert_eq!(fix_overlaps(&mut cues, 0.1), 1);
        assert!(near(cues[0].end, 1.9));
        assert!(near(cues[1].end, 3.0));
    }

    #[test]
    fn makes_lines_readable_without_running_into_the_next() {
        let rules = DurationRules {
            min: 1.0,
            max: 5.0,
            characters_per_second: 10.0,
            gap: 0.1,
        };
        let mut cues = vec![
            // 20 characters want 2 s: the next line allows 1.4.
            cue(0.0, 0.5, "twenty characters!!!"),
            cue(1.5, 1.6, "short"),
            cue(10.0, 30.0, "long"),
        ];
        assert_eq!(fix_durations(&mut cues, rules), 3);
        assert!(near(cues[0].end, 1.4));
        assert!(near(cues[1].end, 2.5));
        assert!(near(cues[2].end, 15.0));
    }

    #[test]
    fn splits_and_joins() {
        let (a, b) = split(&cue(0.0, 3.0, "One two\nthree four five"), 7).unwrap();
        assert_eq!(
            (a.text.as_str(), b.text.as_str()),
            ("One two", "three four five")
        );
        // 7 characters of 22: that share of the 3 s.
        let middle = 3.0 * 7.0 / 22.0;
        assert!(near(a.end, middle) && near(b.start, middle) && near(b.end, 3.0));
        assert!(split(&cue(0.0, 1.0, "x"), 0).is_none());
        let joined = join(&[a, b]).unwrap();
        assert_eq!((joined.start, joined.end), (0.0, 3.0));
        assert_eq!(joined.text, "One two\nthree four five");
    }

    #[test]
    fn snaps_lines_to_speech_and_cuts() {
        let mut cues = vec![cue(1.1, 2.9, "a"), cue(5.0, 5.2, "b"), cue(8.0, 9.0, "c")];
        // Speech from 1.0 to 3.0 and 5.1 to 5.15; a cut at 9.2.
        let starts = [1.0, 5.1, 9.2];
        let ends = [3.0, 5.15, 9.2];
        assert_eq!(snap_edges(&mut cues, &starts, &ends, 0.3, 0.2), 2);
        assert_eq!((cues[0].start, cues[0].end), (1.0, 3.0));
        // Snapped, it'd be too short: left as it was.
        assert_eq!((cues[1].start, cues[1].end), (5.0, 5.2));
        assert_eq!((cues[2].start, cues[2].end), (8.0, 9.2));
    }

    #[test]
    fn snaps_to_the_nearest_edge_in_reach() {
        assert_eq!(snap(10.05, &[9.0, 10.0, 10.3], 0.2), 10.0);
        assert_eq!(snap(10.5, &[9.0, 10.0], 0.2), 10.5);
    }
}
