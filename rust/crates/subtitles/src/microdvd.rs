// MicroDVD: "{start}{end}text|second line", in frames, so it needs the frame
// rate; often the first line gives it, as "{1}{1}23.976". Control codes such
// as {y:i} (this line in italics) and {Y:i} (all of them).

use crate::markup::plain;
use crate::{Cue, Parsed};

const DEFAULT_RATE: f64 = 24000.0 / 1001.0;

fn parse(line: &str) -> Option<(u64, u64, &str)> {
    let rest = line.trim().strip_prefix('{')?;
    let (start, rest) = rest.split_once('}')?;
    let rest = rest.strip_prefix('{')?;
    let (end, text) = rest.split_once('}')?;
    Some((start.parse().ok()?, end.parse().ok()?, text))
}

pub fn is_cue(line: &str) -> bool {
    parse(line).is_some()
}

/// A cue's lines, its control codes made <i>, <b> and <u>, the rest dropped.
fn text(raw: &str) -> String {
    let mut all = Vec::new();
    let lines: Vec<(Vec<char>, String)> = raw
        .split('|')
        .map(|line| {
            let mut styles = Vec::new();
            let mut rest = line;
            while let Some(code) = rest.strip_prefix('{').and_then(|rest| rest.split_once('}')) {
                let (code, after) = code;
                if let Some((kind, value)) = code.split_once(':')
                    && kind.eq_ignore_ascii_case("y")
                {
                    for style in value
                        .chars()
                        .filter(|style| "ibu".contains(style.to_ascii_lowercase()))
                    {
                        let style = style.to_ascii_lowercase();
                        if kind == "Y" {
                            all.push(style)
                        } else {
                            styles.push(style)
                        }
                    }
                }
                rest = after;
            }
            (styles, rest.to_owned())
        })
        .collect();
    lines
        .into_iter()
        .map(|(mut styles, line)| {
            styles.extend(&all);
            styles.sort_unstable();
            styles.dedup();
            let open: String = styles.iter().map(|style| format!("<{style}>")).collect();
            let close: String = styles
                .iter()
                .rev()
                .map(|style| format!("</{style}>"))
                .collect();
            format!("{open}{line}{close}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn read(text_in: &str, frame_rate: Option<f64>) -> Parsed {
    let mut parsed = Parsed::default();
    let mut rate = frame_rate;
    for (index, line) in text_in.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((start, end, raw)) = parse(line) else {
            parsed.skipped += 1;
            continue;
        };
        // "{1}{1}25": the frame rate, as the first line.
        if index == 0
            && start <= 1
            && end <= 1
            && let Ok(given) = raw.trim().parse::<f64>()
            && given > 0.0
        {
            rate = Some(given);
            continue;
        }
        let text = text(raw);
        if plain(&text).trim().is_empty() {
            parsed.skipped += 1;
            continue;
        }
        parsed.cues.push(Cue {
            start: start as f64,
            end: end as f64,
            text,
            style: None,
        });
    }
    let rate = rate.unwrap_or_else(|| {
        parsed.warnings.push(format!(
            "MicroDVD counts frames, and this file doesn't say how many a second: read at {DEFAULT_RATE:.3}"
        ));
        DEFAULT_RATE
    });
    for cue in &mut parsed.cues {
        cue.start /= rate;
        cue.end /= rate;
    }
    parsed
}

pub fn write(cues: &[Cue], frame_rate: f64) -> String {
    // The frame rate first, "{1}{1}25", for it to open at the rate it was
    // saved at.
    let rate = format!("{frame_rate:.3}");
    let mut text = format!(
        "{{1}}{{1}}{}\n",
        rate.trim_end_matches('0').trim_end_matches('.')
    );
    for cue in cues {
        // A code styles a whole line: each style on in any of it, from a tag
        // in it or one still open from the line before.
        let mut open = [false; 3];
        let lines: Vec<String> = cue
            .text
            .lines()
            .map(|line| {
                let mut codes = String::new();
                for (style, is_open) in ["i", "b", "u"].iter().zip(&mut open) {
                    let opened = line.rfind(&format!("<{style}>"));
                    let closed = line.rfind(&format!("</{style}>"));
                    if *is_open || opened.is_some() {
                        codes.push_str(&format!("{{y:{style}}}"));
                    }
                    if opened.is_some() || closed.is_some() {
                        *is_open = opened > closed;
                    }
                }
                format!("{codes}{}", plain(line))
            })
            .collect();
        text.push_str(&format!(
            "{{{}}}{{{}}}{}\n",
            (cue.start * frame_rate).round() as u64,
            (cue.end * frame_rate).round() as u64,
            lines.join("|")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_frame_rate_from_the_first_line() {
        let parsed = read(
            "{1}{1}25\n{25}{50}{y:i}Hello|there\n{Y:b}{75}{100}x\n{100}{125}{Y:b}One|Two\n",
            None,
        );
        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.cues.len(), 2);
        assert_eq!((parsed.cues[0].start, parsed.cues[0].end), (1.0, 2.0));
        assert_eq!(parsed.cues[0].text, "<i>Hello</i>\nthere");
        assert_eq!(parsed.cues[1].text, "<b>One</b>\n<b>Two</b>");
    }

    #[test]
    fn writes_the_frame_rate_and_styles_across_lines() {
        let cues = [Cue {
            start: 1.0,
            end: 2.0,
            text: "<i>One\nTwo</i>\n5 < 6".into(),
            style: None,
        }];
        let text = write(&cues, 25.0);
        assert_eq!(text, "{1}{1}25\n{25}{50}{y:i}One|{y:i}Two|5 < 6\n");
        let parsed = read(&text, None);
        assert!(parsed.warnings.is_empty());
        assert_eq!((parsed.cues[0].start, parsed.cues[0].end), (1.0, 2.0));
        assert!(write(&cues, 24000.0 / 1001.0).starts_with("{1}{1}23.976\n"));
    }

    #[test]
    fn says_when_it_guesses_the_frame_rate() {
        let parsed = read("{24}{48}Hi\n", None);
        assert_eq!(parsed.warnings.len(), 1);
        assert!((parsed.cues[0].start - 1.001).abs() < 1e-9);
    }
}
