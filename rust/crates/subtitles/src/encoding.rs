// A file's text encoding, found: its byte order mark, else UTF-8 if it is,
// else what Mozilla's detector makes of it (old subtitles are often in a
// Windows code page).

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8};

/// The text, and the encoding it was in.
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some((encoding, bom)) = Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom..]);
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
        // Russian in windows-1251.
        let (text, encoding) = decode(b"\xcf\xf0\xe8\xe2\xe5\xf2, \xec\xe8\xf0");
        assert_eq!((text.as_str(), encoding), ("Привет, мир", "windows-1251"));
    }
}
