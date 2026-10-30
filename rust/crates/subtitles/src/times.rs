// Clock times as subtitle files write them: hours, minutes and seconds, the
// fraction after a comma or a full stop, each format with its own digits.

/// Seconds from "h:mm:ss.fff" or "mm:ss.fff", the fraction after ',' or '.'
/// and of any length: none if it isn't a time.
pub fn parse(text: &str) -> Option<f64> {
    let text = text.trim();
    let parts: Vec<&str> = text.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => ("0", *minutes, *seconds),
        [hours, minutes, seconds] => (*hours, *minutes, *seconds),
        _ => return None,
    };
    let number = |part: &str| -> Option<u64> {
        (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    let (whole, fraction) = match seconds.split_once([',', '.']) {
        Some((whole, fraction)) => (whole, fraction),
        None => (seconds, ""),
    };
    let fraction = if fraction.is_empty() {
        0.0
    } else {
        number(fraction)? as f64 / 10f64.powi(fraction.len() as i32)
    };
    let total = number(hours)? * 3600 + number(minutes)? * 60 + number(whole)?;
    Some(total as f64 + fraction)
}

/// "hh:mm:ss" and then `digits` of a second after `separator`.
pub fn format(seconds: f64, separator: char, digits: u32, hour_digits: usize) -> String {
    let scale = 10u64.pow(digits);
    let units = (seconds.max(0.0) * scale as f64).round() as u64;
    let (whole, fraction) = (units / scale, units % scale);
    format!(
        "{:0hour_digits$}:{:02}:{:02}{separator}{:0digits$}",
        whole / 3600,
        whole / 60 % 60,
        whole % 60,
        fraction,
        digits = digits as usize,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ways_files_write_a_time() {
        assert_eq!(parse("00:00:01,500"), Some(1.5));
        assert_eq!(parse("01:02:03.25"), Some(3723.25));
        assert_eq!(parse("02:03.5"), Some(123.5));
        assert_eq!(parse("0:00:07.04"), Some(7.04));
        assert_eq!(parse("100:00:00,000"), Some(360_000.0));
        for not in ["", "1", "a:b:c", "00:00:-1,0", "00:00:01,5x"] {
            assert_eq!(parse(not), None, "{not:?}");
        }
    }

    #[test]
    fn writes_them_as_each_format_wants() {
        assert_eq!(format(3723.25, ',', 3, 2), "01:02:03,250");
        assert_eq!(format(7.044, '.', 2, 1), "0:00:07.04");
        assert_eq!(format(59.9996, '.', 3, 2), "00:01:00.000");
        assert_eq!(format(-1.0, ',', 3, 2), "00:00:00,000");
    }
}
