// The markup kept in a cue's text: <i>, <b> and <u>, as SRT and WebVTT write
// them. Each format's own (ASS override tags, MicroDVD's control codes) is
// turned into these as it's read and back as it's written; the rest is
// dropped, since no other format could say it.

/// HTML-like text (SRT, WebVTT) with only <i>, <b> and <u> left, lowercase.
pub fn keep_simple_tags(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        result.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            result.push_str(&rest[open..]);
            return result;
        };
        let tag = &rest[open + 1..open + close];
        let name = tag
            .trim_start_matches('/')
            .split([' ', '.'])
            .next()
            .unwrap_or("");
        if ["i", "b", "u"].contains(&name.to_ascii_lowercase().as_str()) {
            result.push('<');
            if tag.starts_with('/') {
                result.push('/');
            }
            result.push_str(&name.to_ascii_lowercase());
            result.push('>');
        }
        rest = &rest[open + close + 1..];
    }
    result.push_str(rest);
    result
}

/// The text with no markup at all.
pub fn plain(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_tag = false;
    for character in text.chars() {
        match character {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => result.push(character),
            _ => {}
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_italic_bold_and_underline_only() {
        assert_eq!(
            keep_simple_tags("<I>Yes</I> <font color=\"red\">no</font> <c.loud>so</c> <b>b</b>"),
            "<i>Yes</i> no so <b>b</b>"
        );
        assert_eq!(keep_simple_tags("a < b"), "a < b");
        assert_eq!(plain("<i>Hello</i> there"), "Hello there");
    }
}
