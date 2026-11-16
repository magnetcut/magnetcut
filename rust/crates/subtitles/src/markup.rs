// The markup kept in a cue's text: <i>, <b> and <u>, as SRT and WebVTT write
// them. Each format's own (ASS override tags, MicroDVD's control codes) is
// turned into these as it's read and back as it's written; the rest is
// dropped, since no other format could say it. Any other "<" is text, as in
// "5 < 6".

use crate::times;

const TAGS: [&str; 6] = ["<i>", "</i>", "<b>", "</b>", "<u>", "</u>"];

/// Whether what's between a "<" and the ">" after it is a tag: a name, or
/// "/" and one, as HTML has it, or a WebVTT timestamp ("<00:01.000>").
fn is_tag(inside: &str) -> bool {
    inside
        .strip_prefix('/')
        .unwrap_or(inside)
        .starts_with(|character: char| character.is_ascii_alphabetic())
        || times::parse(inside).is_some()
}

/// HTML-like text (SRT, WebVTT) with only <i>, <b> and <u> left, lowercase.
pub fn keep_simple_tags(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        result.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        // Up to the first ">", with no "<" before it.
        let tag = after
            .find(['<', '>'])
            .filter(|&end| after[end..].starts_with('>'))
            .map(|end| &after[..end])
            .filter(|tag| is_tag(tag));
        let Some(tag) = tag else {
            result.push('<');
            rest = after;
            continue;
        };
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
        rest = &after[tag.len() + 1..];
    }
    result.push_str(rest);
    result
}

/// The text with no markup at all.
pub fn plain(text: &str) -> String {
    TAGS.iter()
        .fold(text.to_owned(), |text, tag| text.replace(tag, ""))
}

/// The text for HTML-like markup (WebVTT): "&", "<" and ">" escaped, except
/// in <i>, <b> and <u>.
pub fn escape(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(character) = rest.chars().next() {
        if let Some(tag) = TAGS.iter().find(|tag| rest.starts_with(**tag)) {
            result.push_str(tag);
            rest = &rest[tag.len()..];
            continue;
        }
        match character {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            _ => result.push(character),
        }
        rest = &rest[character.len_utf8()..];
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

    #[test]
    fn keeps_text_that_only_looks_like_a_tag() {
        for text in ["5 < 6 and 7 > 3", "I <3 you", "a <<i>b", "</> x"] {
            assert_eq!(plain(&keep_simple_tags(text)), plain(text), "{text:?}");
        }
        assert_eq!(keep_simple_tags("a <<i>b</i>"), "a <<i>b</i>");
        assert_eq!(keep_simple_tags("<00:01.500>Hi <v Ann>you"), "Hi you");
        assert_eq!(plain("5 < 6 and 7 > 3"), "5 < 6 and 7 > 3");
    }

    #[test]
    fn escapes_all_but_the_tags_it_keeps() {
        assert_eq!(
            escape("<i>Tom & Jerry</i> <3 -->"),
            "<i>Tom &amp; Jerry</i> &lt;3 --&gt;"
        );
    }
}
