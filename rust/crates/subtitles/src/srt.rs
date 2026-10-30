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
        let Some(at) = block.iter().position(|line| line.contains("-->")) else {
            parsed.skipped += 1;
            continue;
        };
        let Some((start, end)) = timing(block[at]) else {
            parsed.skipped += 1;
            continue;
        };
        let text = keep_simple_tags(&block[at + 1..].join("\n"));
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
    parsed
}

pub fn write(cues: &[Cue]) -> String {
    let mut text = String::new();
    for (index, cue) in cues.iter().enumerate() {
        text.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            times::format(cue.start, ',', 3, 2),
            times::format(cue.end, ',', 3, 2),
            cue.text
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
