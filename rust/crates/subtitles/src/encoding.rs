// A file's text encoding, found: its byte order mark, else UTF-16 by its
// zero bytes, else UTF-8 if it is, else what Mozilla's detector makes of it
// (old subtitles are often in a Windows code page).

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};

/// UTF-16 with no byte order mark, by the zero byte that each ASCII
/// character has (a subtitle file's times are digits): in every other byte,
/// and seldom in the rest. Text in UTF-8 has no zero bytes.
fn utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    let sample = &bytes[..bytes.len().min(4096) & !1];
    let pairs = sample.len() / 2;
    if pairs < 2 {
        return None;
    }
    let zeros = |first: usize| {
        sample
            .iter()
            .skip(first)
            .step_by(2)
            .filter(|&&byte| byte == 0)
            .count()
    };
    let (even, odd) = (zeros(0), zeros(1));
    if odd * 3 > pairs && even * 10 < pairs {
        Some(UTF_16LE)
    } else if even * 3 > pairs && odd * 10 < pairs {
        Some(UTF_16BE)
    } else {
        None
    }
}

/// The text, and the encoding it was in.
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some((encoding, bom)) = Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom..]);
        return (text.into_owned(), encoding.name());
    }
    if let Some(encoding) = utf16_without_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(bytes);
        return (text.into_owned(), encoding.name());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_owned(), UTF_8.name());
    }
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, Utf8Detection::Allow);
    let (text, _) = encoding.decode_without_bom_handling(bytes);
    (text.into_owned(), encoding.name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_encoding() {
        assert_eq!(decode("Grüße".as_bytes()), ("Grüße".to_owned(), "UTF-8"));
        assert_eq!(decode(b"\xef\xbb\xbfHi"), ("Hi".to_owned(), "UTF-8"));
        // UTF-16, little end first, with its mark.
        assert_eq!(decode(b"\xff\xfeH\0i\0"), ("Hi".to_owned(), "UTF-16LE"));
        // UTF-16 with no mark, either end first.
        let text = "1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n";
        let little: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let big: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        assert_eq!(decode(&little), (text.to_owned(), "UTF-16LE"));
        assert_eq!(decode(&big), (text.to_owned(), "UTF-16BE"));
        // Russian in windows-1251.
        let (text, encoding) = decode(b"\xcf\xf0\xe8\xe2\xe5\xf2, \xec\xe8\xf0");
        assert_eq!((text.as_str(), encoding), ("Привет, мир", "windows-1251"));
    }
}
