// WebVTT: "WEBVTT", then blocks, each an optional name, a timing line with
// optional settings, and the lines; notes, styles and regions aside.

use crate::markup::keep_simple_tags;
use crate::srt::blocks;
use crate::{Cue, Parsed, times};

fn decode_entities(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        result.push_str(&rest[..at]);
        let entity = rest[at..].find(';').map(|end| &rest[at + 1..at + end]);
        let decoded = match entity {
            Some("amp") => Some('&'),
            Some("lt") => Some('<'),
            Some("gt") => Some('>'),
            Some("nbsp") => Some('\u{a0}'),
            Some("lrm") => Some('\u{200e}'),
            Some("rlm") => Some('\u{200f}'),
            Some(code) if code.starts_with('#') => {
                code[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        match (decoded, entity) {
            (Some(character), Some(entity)) => {
                result.push(character);
                rest = &rest[at + entity.len() + 2..];
            }
            _ => {
                result.push('&');
                rest = &rest[at + 1..];
            }
        }
    }
    result.push_str(rest);
    result
}

pub fn read(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    for block in blocks(text).into_iter().skip(1) {
        let first = block[0];
        if ["NOTE", "STYLE", "REGION"]
            .iter()
            .any(|word| first == *word || first.starts_with(&format!("{word} ")))
        {
            continue;
        }
        let Some(at) = block.iter().position(|line| line.contains("-->")) else {
            parsed.skipped += 1;
            continue;
        };
        let line = block[at];
        let (start, rest) = line.split_once("-->").unwrap_or((line, ""));
        let end = rest.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (times::parse(start), times::parse(end)) else {
            parsed.skipped += 1;
            continue;
        };
        let text = decode_entities(&keep_simple_tags(&block[at + 1..].join("\n")));
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
    let mut text = String::from("WEBVTT\n\n");
    for cue in cues {
        text.push_str(&format!(
            "{} --> {}\n{}\n\n",
            times::format(cue.start, '.', 3, 2),
            times::format(cue.end, '.', 3, 2),
            cue.text.replace('&', "&amp;")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cues_and_skips_notes_and_styles() {
        let text = "WEBVTT - film\n\nNOTE a note\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.000 line:90%\n<v Ann>Tom &amp; <b>Jerry</b></v>\n\n00:00:03.500 --> 00:00:04.000\n<c.loud>Hey</c> &lt;3\n";
        let parsed = read(text);
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.cues.len(), 2);
        assert_eq!(parsed.cues[0].text, "Tom & <b>Jerry</b>");
        assert_eq!((parsed.cues[0].start, parsed.cues[0].end), (1.0, 2.0));
        assert_eq!(parsed.cues[1].text, "Hey <3");
    }

    #[test]
    fn writes_the_header_and_escapes_ampersands() {
        let cues = [Cue {
            start: 1.0,
            end: 2.0,
            text: "Tom & <i>Jerry</i>".into(),
            style: None,
        }];
        assert_eq!(
            write(&cues),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; <i>Jerry</i>\n\n"
        );
    }
}
