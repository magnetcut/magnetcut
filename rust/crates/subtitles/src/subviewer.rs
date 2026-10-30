// SubViewer 2.0: an [INFORMATION] header, then blocks of
// "00:00:01.00,00:00:02.00" and the text, its lines split by [br].

use crate::markup::plain;
use crate::srt::blocks;
use crate::{Cue, Parsed, times};

fn timing(line: &str) -> Option<(f64, f64)> {
    let (start, end) = line.trim().split_once(',')?;
    Some((times::parse(start)?, times::parse(end)?))
}

/// Whether the text starts with a SubViewer timing line, as one with no
/// header does.
pub fn starts(text: &str) -> bool {
    text.lines()
        .next()
        .is_some_and(|line| timing(line).is_some())
}

pub fn read(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    for block in blocks(text) {
        let Some(at) = block.iter().position(|line| timing(line).is_some()) else {
            // The header, and lines like [COLF] that set colours and fonts.
            if !block.iter().all(|line| line.trim_start().starts_with('[')) {
                parsed.skipped += 1;
            }
            continue;
        };
        let (start, end) = timing(block[at]).unwrap_or_default();
        let text = block[at + 1..]
            .join("\n")
            .replace("[br]", "\n")
            .replace("[BR]", "\n");
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
    let mut text = String::from(
        "[INFORMATION]\n[TITLE]\n[AUTHOR]\n[SOURCE]\n[PRG]\n[FILEPATH]\n[DELAY]0\n[CD TRACK]0\n[COMMENT]\n[END INFORMATION]\n[SUBTITLE]\n[COLF]&HFFFFFF,[STYLE]no,[SIZE]18,[FONT]Arial\n\n",
    );
    for cue in cues {
        text.push_str(&format!(
            "{},{}\n{}\n\n",
            times::format(cue.start, '.', 2, 2),
            times::format(cue.end, '.', 2, 2),
            plain(&cue.text).replace('\n', "[br]")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_after_the_header() {
        let text = "[INFORMATION]\n[TITLE]Film\n[END INFORMATION]\n[SUBTITLE]\n[COLF]&HFFFFFF,[SIZE]18\n\n00:00:01.50,00:00:03.25\nHello[br]there\n\n00:00:04.00,00:00:05.00\nBye\n";
        let parsed = read(text);
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.cues.len(), 2);
        assert_eq!(parsed.cues[0].text, "Hello\nthere");
        assert_eq!((parsed.cues[0].start, parsed.cues[0].end), (1.5, 3.25));
    }
}
