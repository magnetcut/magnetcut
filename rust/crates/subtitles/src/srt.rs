// SubRip: numbered blocks, "00:00:01,000 --> 00:00:02,000", then the lines.

use crate::markup::keep_simple_tags;
use crate::{Cue, Parsed, times};

/// Whether a line is a timing line: two times either side of an arrow.
pub fn is_timing(line: &str) -> bool {
    timing(line).is_some()
}

fn timing(line: &str) -> Option<(f64, f64)> {
    let (start, end) = line.split_once("-->")?;
    // Some writers add a position after the end time.
    let end = end.split_whitespace().next()?;
    Some((times::parse(start)?, times::parse(end)?))
}

/// The blocks of a file, split at blank lines.
pub fn blocks(text: &str) -> Vec<Vec<&str>> {
    let mut blocks = Vec::new();
    let mut block = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r').trim_start_matches('\u{feff}');
        if line.trim().is_empty() {
            if !block.is_empty() {
                blocks.push(std::mem::take(&mut block));
            }
        } else {
            block.push(line);
        }
    }
    if !block.is_empty() {
        blocks.push(block);
    }
    blocks
}

pub fn read(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    for block in blocks(text) {
        // Each timing line starts a cue, even with no blank line before it.
        let timings: Vec<(usize, (f64, f64))> = block
            .iter()
            .enumerate()
            .filter_map(|(at, line)| Some((at, timing(line)?)))
            .collect();
        if timings.is_empty() {
            parsed.skipped += 1;
            continue;
        }
        for (index, &(at, (start, end))) in timings.iter().enumerate() {
            let mut until = timings.get(index + 1).map_or(block.len(), |next| next.0);
            // The next cue's number, just before its timing line.
            if until < block.len()
                && until > at + 1
                && block[until - 1]
                    .trim()
                    .bytes()
                    .all(|byte| byte.is_ascii_digit())
            {
                until -= 1;
            }
            let text = keep_simple_tags(&block[at + 1..until].join("\n"));
            if text.trim().is_empty() {
                parsed.skipped += 1;
                continue;
            }
            parsed.cues.push(Cue {
                start,
                end,
                text,
                style: None,
            });
        }
    }
    parsed
}

/// A cue's text with its blank lines left out: in a file of blocks (SRT,
/// WebVTT) a blank line would end the cue.
pub fn folded(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn write(cues: &[Cue]) -> String {
    let mut text = String::new();
    for (index, cue) in cues.iter().enumerate() {
        text.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            times::format(cue.start, ',', 3, 2),
            times::format(cue.end, ',', 3, 2),
            folded(&cue.text)
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_blocks_and_skips_broken_ones() {
        let text = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500 X1:10\r\n<font color=\"#fff\">Hi</font>\r\nthere\r\n\r\n2\r\nno timing\r\n\r\n3\r\n00:00:03,000 --> 00:00:04,000\r\n<i>Bye</i>\r\n";
        let parsed = read(text);
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.cues.len(), 2);
        assert_eq!(parsed.cues[0].text, "Hi\nthere");
        assert_eq!((parsed.cues[0].start, parsed.cues[0].end), (1.0, 2.5));
        assert_eq!(parsed.cues[1].text, "<i>Bye</i>");
    }

    #[test]
    fn reads_cues_with_no_blank_line_between_them() {
        let text = "1\n00:00:01,000 --> 00:00:02,000\nHow old?\n42\n2\n00:00:03,000 --> 00:00:04,000\nOld.\n00:00:05,000 --> 00:00:06,000\nNo number\n";
        let parsed = read(text);
        let cues: Vec<(f64, &str)> = parsed
            .cues
            .iter()
            .map(|cue| (cue.start, cue.text.as_str()))
            .collect();
        assert_eq!(
            cues,
            [(1.0, "How old?\n42"), (3.0, "Old."), (5.0, "No number")]
        );
        assert_eq!(parsed.skipped, 0);
    }

    #[test]
    fn writes_numbered_blocks() {
        let cues = [Cue {
            start: 61.5,
            end: 62.0,
            text: "One\nTwo".into(),
            style: None,
        }];
        assert_eq!(
            write(&cues),
            "1\n00:01:01,500 --> 00:01:02,000\nOne\nTwo\n\n"
        );
    }
}
