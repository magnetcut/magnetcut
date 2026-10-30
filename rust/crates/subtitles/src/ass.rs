// Advanced SubStation Alpha and SubStation Alpha (v4): a [Script Info]
// header, styles, then [Events] with "Dialogue:" lines whose fields a
// "Format:" line names. The header and styles are kept to write the file back
// as it was; of each line's override tags, italics, bold and underline.

use serde::{Deserialize, Serialize};

use crate::{Cue, Parsed, times};

/// A style, as the editor can use it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssStyle {
    pub name: String,
    pub font_name: String,
    /// In the script's pixels: `play_res_y` of them make the picture's height.
    pub font_size: f64,
    /// CSS colours, "#rrggbbaa".
    pub primary_color: String,
    pub outline_color: String,
    pub back_color: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// Where on the picture, as a numeric keypad: 1 bottom left, 5 the
    /// middle, 9 top right.
    pub alignment: u8,
    pub margin_left: f64,
    pub margin_right: f64,
    pub margin_vertical: f64,
}

/// What's kept of an ASS or SSA file besides its lines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssScript {
    /// Everything before [Events], as it was.
    pub head: String,
    pub is_ssa: bool,
    pub play_res_x: f64,
    pub play_res_y: f64,
    pub styles: Vec<AssStyle>,
}

const ASS_HEAD: &str = "[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,50,1
";

const SSA_HEAD: &str = "[Script Info]
ScriptType: v4.00
PlayResX: 1920
PlayResY: 1080

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,64,16777215,255,0,0,0,0,1,3,1,2,60,60,50,0,1
";

/// A colour as ASS writes it ("&HAABBGGRR", or SSA's decimal BGR) as CSS.
fn css_color(value: &str) -> String {
    let value = value.trim();
    let number = match value
        .strip_prefix("&H")
        .or_else(|| value.strip_prefix("&h"))
    {
        Some(hex) => u32::from_str_radix(hex.trim_end_matches('&'), 16).unwrap_or(0),
        None => value.parse::<i64>().unwrap_or(0) as u32,
    };
    let [red, green, blue, alpha] = number.to_le_bytes();
    // ASS's alpha is transparency: 0 opaque.
    format!("#{red:02x}{green:02x}{blue:02x}{:02x}", 255 - alpha)
}

/// SSA's alignment (1-3 bottom, 5-7 top, 9-11 middle) as a keypad's.
fn keypad(ssa: u8) -> u8 {
    match ssa {
        5..=7 => ssa + 2,
        9..=11 => ssa - 5,
        _ => ssa,
    }
}

fn style(format: &[String], values: &str, is_ssa: bool) -> Option<AssStyle> {
    let values: Vec<&str> = values.splitn(format.len(), ',').map(str::trim).collect();
    let field = |name: &str| {
        format
            .iter()
            .position(|field| field.eq_ignore_ascii_case(name))
            .and_then(|at| values.get(at).copied())
    };
    let number = |name: &str| field(name).and_then(|value| value.parse::<f64>().ok());
    let flag = |name: &str| number(name).is_some_and(|value| value != 0.0);
    let alignment = number("Alignment").unwrap_or(2.0) as u8;
    Some(AssStyle {
        name: field("Name")?.to_owned(),
        font_name: field("Fontname").unwrap_or("Arial").to_owned(),
        font_size: number("Fontsize").unwrap_or(20.0),
        primary_color: css_color(field("PrimaryColour").unwrap_or("&H00FFFFFF")),
        outline_color: css_color(
            field("OutlineColour")
                .or(field("TertiaryColour"))
                .unwrap_or("&H00000000"),
        ),
        back_color: css_color(field("BackColour").unwrap_or("&H80000000")),
        bold: flag("Bold"),
        italic: flag("Italic"),
        underline: flag("Underline"),
        alignment: if is_ssa { keypad(alignment) } else { alignment },
        margin_left: number("MarginL").unwrap_or(0.0),
        margin_right: number("MarginR").unwrap_or(0.0),
        margin_vertical: number("MarginV").unwrap_or(0.0),
    })
}

/// A line's text as the model has it: its override tags made <i>, <b> and
/// <u> or dropped, its breaks made new lines.
fn from_ass(text: &str) -> String {
    let mut result = String::new();
    let mut open = [false; 3];
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(block) = rest.strip_prefix('{') {
            let Some((tags, after)) = block.split_once('}') else {
                break;
            };
            for tag in tags.split('\\').filter(|tag| !tag.is_empty()) {
                for (index, name) in ["i", "b", "u"].iter().enumerate() {
                    let Some(value) = tag.strip_prefix(name) else {
                        continue;
                    };
                    // \b takes a weight too: \b700.
                    let Ok(value) = value.parse::<u32>() else {
                        continue;
                    };
                    let on = value == 1 || (index == 1 && value >= 600);
                    if on != open[index] {
                        open[index] = on;
                        result.push_str(if on { "<" } else { "</" });
                        result.push_str(name);
                        result.push('>');
                    }
                }
            }
            rest = after;
        } else if let Some(after) = rest
            .strip_prefix("\\N")
            .or_else(|| rest.strip_prefix("\\n"))
        {
            result.push('\n');
            rest = after;
        } else if let Some(after) = rest.strip_prefix("\\h") {
            result.push('\u{a0}');
            rest = after;
        } else {
            let next = rest[1..].find(['{', '\\']).map_or(rest.len(), |at| at + 1);
            result.push_str(&rest[..next]);
            rest = &rest[next..];
        }
    }
    for (index, name) in ["i", "b", "u"].iter().enumerate().rev() {
        if open[index] {
            result.push_str(&format!("</{name}>"));
        }
    }
    result
}

fn to_ass(text: &str) -> String {
    text.replace("<i>", "{\\i1}")
        .replace("</i>", "{\\i0}")
        .replace("<b>", "{\\b1}")
        .replace("</b>", "{\\b0}")
        .replace("<u>", "{\\u1}")
        .replace("</u>", "{\\u0}")
        .replace('\n', "\\N")
}

pub fn read(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut section = String::new();
    let mut head = String::new();
    let mut is_ssa = false;
    let (mut play_res_x, mut play_res_y) = (384.0, 288.0);
    let mut style_format: Vec<String> = Vec::new();
    let mut event_format: Vec<String> = Vec::new();
    let mut styles = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r').trim_start_matches('\u{feff}');
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_ascii_lowercase();
            if section == "[v4 styles]" {
                is_ssa = true;
            }
        }
        if section != "[events]" {
            head.push_str(line);
            head.push('\n');
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let fields = || {
            value
                .split(',')
                .map(|field| field.trim().to_owned())
                .collect()
        };
        match (section.as_str(), key.trim()) {
            ("[script info]", "PlayResX") => play_res_x = value.parse().unwrap_or(play_res_x),
            ("[script info]", "PlayResY") => play_res_y = value.parse().unwrap_or(play_res_y),
            ("[v4+ styles]" | "[v4 styles]", "Format") => style_format = fields(),
            ("[v4+ styles]" | "[v4 styles]", "Style") => {
                styles.extend(style(&style_format, value, is_ssa));
            }
            ("[events]", "Format") => event_format = fields(),
            ("[events]", "Dialogue") => {
                let values: Vec<&str> = value.splitn(event_format.len().max(1), ',').collect();
                let field = |name: &str| {
                    event_format
                        .iter()
                        .position(|field| field.eq_ignore_ascii_case(name))
                        .and_then(|at| values.get(at).copied())
                };
                let (Some(start), Some(end), Some(text)) = (
                    field("Start").and_then(times::parse),
                    field("End").and_then(times::parse),
                    field("Text"),
                ) else {
                    parsed.skipped += 1;
                    continue;
                };
                let text = from_ass(text);
                if text.trim().is_empty() {
                    parsed.skipped += 1;
                    continue;
                }
                parsed.cues.push(Cue {
                    start,
                    end,
                    text,
                    style: field("Style")
                        .map(|style| style.trim().trim_start_matches('*').to_owned()),
                });
            }
            _ => {}
        }
    }
    parsed.ass = Some(AssScript {
        head,
        is_ssa,
        play_res_x,
        play_res_y,
        styles,
    });
    parsed
}

/// The file: the script's own header and styles if it was one of this kind,
/// otherwise a default style for 1080p.
pub fn write(cues: &[Cue], script: Option<&AssScript>, is_ssa: bool) -> String {
    let script = script.filter(|script| script.is_ssa == is_ssa);
    let mut text = match script {
        Some(script) => script.head.trim_end().to_owned(),
        None => (if is_ssa { SSA_HEAD } else { ASS_HEAD })
            .trim_end()
            .to_owned(),
    };
    text.push_str("\n\n[Events]\n");
    text.push_str(if is_ssa {
        "Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    } else {
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    });
    for cue in cues {
        let style = cue
            .style
            .as_deref()
            .filter(|style| {
                script.is_some_and(|script| script.styles.iter().any(|known| known.name == *style))
            })
            .unwrap_or("Default");
        text.push_str(&format!(
            "Dialogue: {},{},{},{style},,0,0,0,,{}\n",
            if is_ssa { "Marked=0" } else { "0" },
            times::format(cue.start, '.', 2, 1),
            times::format(cue.end, '.', 2, 1),
            to_ass(&cue.text)
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "[Script Info]
Title: Film
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1
Style: Sign,Georgia,36,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,1,0,0,100,100,0,0,1,2,1,8,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown
Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\an8\\i1}Hello,{\\i0} there\\Nfriend
Dialogue: 0,0:00:04.00,0:00:05.00,Sign,,0,0,0,,{\\b700}Exit{\\b0}
";

    #[test]
    fn reads_styles_and_lines() {
        let parsed = read(SCRIPT);
        let script = parsed.ass.as_ref().unwrap();
        assert!(!script.is_ssa);
        assert_eq!((script.play_res_x, script.play_res_y), (1280.0, 720.0));
        assert_eq!(script.styles.len(), 2);
        let sign = &script.styles[1];
        assert_eq!(sign.font_name, "Georgia");
        assert_eq!(sign.primary_color, "#ffff00ff");
        assert!(sign.italic && !sign.bold);
        assert_eq!(sign.alignment, 8);
        assert!(script.styles[0].bold);
        assert_eq!(parsed.cues.len(), 2);
        assert_eq!(parsed.cues[0].text, "<i>Hello,</i> there\nfriend");
        assert_eq!((parsed.cues[0].start, parsed.cues[0].end), (1.5, 3.25));
        assert_eq!(parsed.cues[1].text, "<b>Exit</b>");
        assert_eq!(parsed.cues[1].style.as_deref(), Some("Sign"));
    }

    #[test]
    fn writes_the_script_back_with_its_styles() {
        let parsed = read(SCRIPT);
        let text = write(&parsed.cues, parsed.ass.as_ref(), false);
        assert!(text.contains("Title: Film") && text.contains("Style: Sign,Georgia"));
        assert!(text.contains(
            "Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\i1}Hello,{\\i0} there\\Nfriend"
        ));
        assert!(text.contains(",Sign,,0,0,0,,{\\b1}Exit{\\b0}"));
        assert_eq!(read(&text).cues, parsed.cues);
    }

    #[test]
    fn reads_ssa_alignment_as_a_keypad() {
        assert_eq!(
            [1, 2, 3, 5, 6, 7, 9, 10, 11].map(keypad),
            [1, 2, 3, 7, 8, 9, 4, 5, 6]
        );
        assert_eq!(css_color("16777215"), "#ffffffff");
    }
}
