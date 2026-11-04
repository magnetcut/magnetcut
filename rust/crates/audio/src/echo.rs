//! An echo: the sound again after a delay, each repeat the feedback's share
//! of the one before, mixed with the original.

use crate::settings::Echo as Settings;

pub(crate) struct Echo {
    feedback: f32,
    mix: f32,
    /// Per channel, the last delay's worth of what goes into the delay: the
    /// input plus the feedback.
    lines: Vec<Vec<f32>>,
    /// Where the oldest sample is, the same in every line.
    at: usize,
}

impl Echo {
    pub(crate) fn new(settings: Settings, sample_rate: f32, channels: usize) -> Echo {
        let delay = ((settings.delay / 1000.0 * sample_rate).round() as usize).max(1);
        Echo {
            feedback: settings.feedback,
            mix: settings.mix,
            lines: vec![vec![0.0; delay]; channels],
            at: 0,
        }
    }

    pub(crate) fn process(&mut self, channels: &mut [Vec<f32>]) {
        let start = self.at;
        for (samples, line) in channels.iter_mut().zip(&mut self.lines) {
            let mut at = start;
            for sample in samples.iter_mut() {
                let delayed = line[at];
                let fed = *sample + self.feedback * delayed;
                // Silence fed back decays towards subnormal numbers, which
                // are slow on some CPUs.
                line[at] = if fed.abs() < 1e-25 { 0.0 } else { fed };
                *sample += self.mix * (delayed - *sample);
                at += 1;
                if at == line.len() {
                    at = 0;
                }
            }
            self.at = at;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_impulse_repeats_at_the_delay() {
        let rate = 48_000.0;
        let settings = Settings {
            delay: 100.0,
            feedback: 0.5,
            mix: 0.4,
        };
        let mut echo = Echo::new(settings, rate, 2);
        let delay = 4800;
        let mut signal = vec![vec![0.0f32; delay * 4]; 2];
        signal[0][0] = 1.0;
        signal[1][0] = -1.0;
        echo.process(&mut signal);
        let left = &signal[0];
        assert!((left[0] - 0.6).abs() < 1e-6);
        assert!((left[delay] - 0.4).abs() < 1e-6);
        assert!((left[2 * delay] - 0.2).abs() < 1e-6);
        assert!((left[3 * delay] - 0.1).abs() < 1e-6);
        let elsewhere = left
            .iter()
            .enumerate()
            .filter(|(n, _)| n % delay != 0)
            .all(|(_, value)| *value == 0.0);
        assert!(elsewhere);
        assert!((signal[1][delay] + 0.4).abs() < 1e-6);
    }
}
