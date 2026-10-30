//! When a transition between two touching clips plays. It shows media past the
//! cut, the outgoing clip's tail handle (what's trimmed off its end) and the
//! incoming clip's head handle, so the clips stay where they are. Its window is
//! centred on the cut, ends at it or starts at it, and is shortened to what the
//! handles and the clips allow.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::{FrameRate, MediaTime};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransitionAlignment {
    /// Half before the cut, half after.
    Center,
    /// Ending at the cut: the incoming clip starts early, from its head handle.
    End,
    /// Starting at the cut: the outgoing clip goes on, into its tail handle.
    Start,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionWindowOptions {
    /// Where the outgoing clip ends and the incoming one starts.
    pub cut: MediaTime,
    /// How long it should last.
    pub duration: MediaTime,
    pub alignment: TransitionAlignment,
    /// How long the outgoing clip can go on past its end, in timeline time;
    /// none for no limit (an image).
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub from_handle: Option<MediaTime>,
    /// How long the incoming clip can start before its start.
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub to_handle: Option<MediaTime>,
    /// The clips' durations: the window stays within both.
    pub from_duration: MediaTime,
    pub to_duration: MediaTime,
    /// With a rate, a shortened window is a whole number of frames.
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub rate: Option<FrameRate>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionWindow {
    /// When it starts: before, the outgoing clip alone.
    pub start: MediaTime,
    /// When it ends: from here, the incoming clip alone.
    pub end: MediaTime,
    /// Shorter than asked for: the handles or the clips allow no more.
    pub clamped: bool,
}

/// The longest it can be at this cut.
fn longest(options: &TransitionWindowOptions) -> MediaTime {
    let limit = |handle: Option<MediaTime>| handle.unwrap_or(MediaTime::from_ticks(i64::MAX));
    // Before the cut: the outgoing clip itself, and the incoming one's head
    // handle. After it: the outgoing one's tail handle, and the incoming clip.
    let before = options.from_duration.min(limit(options.to_handle));
    let after = limit(options.from_handle).min(options.to_duration);
    match options.alignment {
        TransitionAlignment::Center => {
            MediaTime::from_ticks(before.min(after).as_ticks().saturating_mul(2))
        }
        TransitionAlignment::End => before,
        TransitionAlignment::Start => after,
    }
}

/// Where it plays: none when the cut leaves no room for it.
#[export]
pub fn transition_window(options: TransitionWindowOptions) -> Option<TransitionWindow> {
    let mut duration = options.duration.min(longest(&options));
    let clamped = duration < options.duration;
    if let (true, Some(rate)) = (clamped, options.rate) {
        duration = duration.floor_to_frame(rate).unwrap_or(duration);
    }
    if duration <= MediaTime::ZERO {
        return None;
    }
    let cut = options.cut;
    let (start, end) = match options.alignment {
        TransitionAlignment::Center => {
            let start = cut - duration / 2;
            (start, start + duration)
        }
        TransitionAlignment::End => (cut - duration, cut),
        TransitionAlignment::Start => (cut, cut + duration),
    };
    Some(TransitionWindow {
        start,
        end,
        clamped,
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionProgressOptions {
    pub start: MediaTime,
    pub end: MediaTime,
    pub time: MediaTime,
}

/// How far into its window it is at that time, from 0 (the outgoing clip) to
/// 1 (the incoming one).
#[export]
pub fn transition_progress(
    TransitionProgressOptions { start, end, time }: TransitionProgressOptions,
) -> f64 {
    if end <= start {
        return 1.0;
    }
    let elapsed = (time - start).as_ticks() as f64;
    let length = (end - start).as_ticks() as f64;
    (elapsed / length).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: i64 = time::TICKS_PER_SECOND;

    fn seconds(value: f64) -> MediaTime {
        MediaTime::from_seconds_f64(value).unwrap()
    }

    /// A cut at 10 s between two 5 s clips, with 2 s of handle each.
    fn options(alignment: TransitionAlignment, duration: f64) -> TransitionWindowOptions {
        TransitionWindowOptions {
            cut: seconds(10.0),
            duration: seconds(duration),
            alignment,
            from_handle: Some(seconds(2.0)),
            to_handle: Some(seconds(2.0)),
            from_duration: seconds(5.0),
            to_duration: seconds(5.0),
            rate: None,
        }
    }

    fn window(start: f64, end: f64, clamped: bool) -> Option<TransitionWindow> {
        Some(TransitionWindow {
            start: seconds(start),
            end: seconds(end),
            clamped,
        })
    }

    #[test]
    fn centred_on_the_cut() {
        let result = transition_window(options(TransitionAlignment::Center, 1.0));
        assert_eq!(result, window(9.5, 10.5, false));
    }

    #[test]
    fn ending_or_starting_at_the_cut() {
        let end = transition_window(options(TransitionAlignment::End, 1.0));
        assert_eq!(end, window(9.0, 10.0, false));
        let start = transition_window(options(TransitionAlignment::Start, 1.0));
        assert_eq!(start, window(10.0, 11.0, false));
    }

    #[test]
    fn shortened_to_the_handles() {
        // Centred, each side has 2 s: 4 s at most.
        let centred = transition_window(options(TransitionAlignment::Center, 6.0));
        assert_eq!(centred, window(8.0, 12.0, true));
        // Ending at the cut, all of it is in the incoming clip's head handle.
        let end = transition_window(options(TransitionAlignment::End, 3.0));
        assert_eq!(end, window(8.0, 10.0, true));
    }

    #[test]
    fn the_shorter_handle_decides() {
        let mut options = options(TransitionAlignment::Center, 2.0);
        options.from_handle = Some(seconds(0.25));
        assert_eq!(transition_window(options), window(9.75, 10.25, true));
    }

    #[test]
    fn shortened_to_the_clips() {
        // Images have no handle limit, but the window stays within the clips.
        let mut options = options(TransitionAlignment::Center, 10.0);
        options.from_handle = None;
        options.to_handle = None;
        options.from_duration = seconds(1.5);
        assert_eq!(transition_window(options), window(8.5, 11.5, true));
    }

    #[test]
    fn whole_frames_when_shortened() {
        let mut options = options(TransitionAlignment::End, 1.0);
        options.to_handle = Some(MediaTime::from_ticks(SECOND / 2 + 7));
        options.rate = Some(FrameRate::FPS_24);
        // 0.5 s and 7 ticks: 12 frames.
        assert_eq!(transition_window(options), window(9.5, 10.0, true));
    }

    #[test]
    fn none_without_handles() {
        let mut options = options(TransitionAlignment::Center, 1.0);
        options.to_handle = Some(MediaTime::ZERO);
        assert_eq!(transition_window(options), None);
        assert_eq!(
            transition_window(self::options(TransitionAlignment::Center, 0.0)),
            None
        );
    }

    #[test]
    fn progress_across_the_window() {
        let at = |time: f64| {
            transition_progress(TransitionProgressOptions {
                start: seconds(9.5),
                end: seconds(10.5),
                time: seconds(time),
            })
        };
        assert_eq!(at(9.0), 0.0);
        assert_eq!(at(9.5), 0.0);
        assert_eq!(at(10.0), 0.5);
        assert_eq!(at(10.5), 1.0);
        assert_eq!(at(11.0), 1.0);
    }
}
