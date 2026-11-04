//! Freeverb, Jezar at Dreampoint's public-domain reverb: eight damped comb
//! filters side by side, then four all-passes in a row, per side; the right
//! side's delays a little longer than the left's, which makes it wide. The
//! delays are Freeverb's, made for 44.1 kHz, scaled to the sample rate.

use crate::settings::Reverb as Settings;

const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
/// How much longer the right side's delays are.
const SPREAD: usize = 23;
const ALLPASS_FEEDBACK: f32 = 0.5;
/// Freeverb's input gain: eight combs add up to a lot.
const INPUT_GAIN: f32 = 0.015;
/// Freeverb's wet scale, which brings the reverb to about the original's
/// loudness.
const WET_SCALE: f32 = 3.0;

/// Silence fed back decays towards subnormal numbers, which are slow on some
/// CPUs: Freeverb's "undenormalise".
fn flush(value: f32) -> f32 {
    if value.abs() < 1e-25 { 0.0 } else { value }
}

struct Comb {
    buffer: Vec<f32>,
    at: usize,
    /// The one-pole low-pass in the loop: high frequencies die away sooner.
    store: f32,
}

impl Comb {
    fn new(length: usize) -> Comb {
        Comb {
            buffer: vec![0.0; length.max(1)],
            at: 0,
            store: 0.0,
        }
    }

    fn process(&mut self, input: f32, feedback: f32, damp: f32) -> f32 {
        let output = self.buffer[self.at];
        self.store = flush(output * (1.0 - damp) + self.store * damp);
        self.buffer[self.at] = flush(input + self.store * feedback);
        self.at += 1;
        if self.at == self.buffer.len() {
            self.at = 0;
        }
        output
    }
}

struct Allpass {
    buffer: Vec<f32>,
    at: usize,
}

impl Allpass {
    fn new(length: usize) -> Allpass {
        Allpass {
            buffer: vec![0.0; length.max(1)],
            at: 0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let delayed = self.buffer[self.at];
        self.buffer[self.at] = flush(input + delayed * ALLPASS_FEEDBACK);
        self.at += 1;
        if self.at == self.buffer.len() {
            self.at = 0;
        }
        delayed - input
    }
}

/// One side's filters.
struct Tank {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
}

impl Tank {
    fn new(scale: f64, spread: usize) -> Tank {
        let length = |samples: usize| ((samples + spread) as f64 * scale).round() as usize;
        Tank {
            combs: COMBS.iter().map(|&n| Comb::new(length(n))).collect(),
            allpasses: ALLPASSES.iter().map(|&n| Allpass::new(length(n))).collect(),
        }
    }

    fn process(&mut self, input: f32, feedback: f32, damp: f32) -> f32 {
        let mut output = 0.0;
        for comb in &mut self.combs {
            output += comb.process(input, feedback, damp);
        }
        for allpass in &mut self.allpasses {
            output = allpass.process(output);
        }
        output
    }
}

pub(crate) struct Reverb {
    feedback: f32,
    damp: f32,
    /// A side's own reverb and the other side's, in its output.
    own: f32,
    other: f32,
    mix: f32,
    left: Tank,
    /// None for mono.
    right: Option<Tank>,
}

impl Reverb {
    pub(crate) fn new(settings: Settings, sample_rate: f32, channels: usize) -> Reverb {
        let scale = f64::from(sample_rate) / 44_100.0;
        // Freeverb's mapping of its room size and damping, with the damping's
        // low-pass moved so it cuts at the same frequency at any rate.
        let damp = (settings.damping * 0.4).powf((44_100.0 / sample_rate).min(16.0));
        let width = settings.width;
        Reverb {
            feedback: settings.room_size * 0.28 + 0.7,
            damp,
            own: WET_SCALE * (width / 2.0 + 0.5),
            other: WET_SCALE * ((1.0 - width) / 2.0),
            mix: settings.mix,
            left: Tank::new(scale, 0),
            right: (channels >= 2).then(|| Tank::new(scale, SPREAD)),
        }
    }

    /// Freeverb sums its inputs into one, so a sound panned left reverberates
    /// on both sides; with more than two channels, the even ones get the left
    /// side's mix and the odd ones the right's.
    pub(crate) fn process(&mut self, channels: &mut [Vec<f32>]) {
        let length = channels.first().map_or(0, Vec::len);
        // Mono is taken as the same sound on two channels, as Freeverb would
        // hear it.
        let gain = INPUT_GAIN * 2.0 / channels.len().max(1) as f32;
        for n in 0..length {
            let input = channels.iter().map(|channel| channel[n]).sum::<f32>() * gain;
            let left = self.left.process(input, self.feedback, self.damp);
            let (wet_left, wet_right) = match &mut self.right {
                Some(tank) => {
                    let right = tank.process(input, self.feedback, self.damp);
                    (
                        left * self.own + right * self.other,
                        right * self.own + left * self.other,
                    )
                }
                None => (left * WET_SCALE, 0.0),
            };
            for (c, channel) in channels.iter_mut().enumerate() {
                let wet = if c % 2 == 0 { wet_left } else { wet_right };
                let dry = channel[n];
                channel[n] = dry + self.mix * (wet - dry);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn an_impulse_dies_away() {
        for (rate, channels) in [(44_100.0, 2), (48_000.0, 1), (96_000.0, 2)] {
            let settings = Settings {
                room_size: 0.8,
                damping: 0.5,
                width: 1.0,
                mix: 1.0,
            };
            let mut reverb = Reverb::new(settings, rate, channels);
            let second = rate as usize;
            let mut signal = vec![vec![0.0f32; second * 6]; channels];
            for channel in &mut signal {
                channel[0] = 1.0;
            }
            reverb.process(&mut signal);
            for channel in &signal {
                assert!(channel.iter().all(|value| value.is_finite()));
                let levels: Vec<f32> = channel.chunks(second / 2).map(rms).collect();
                assert!(levels[0] > 1e-3, "{rate}: {levels:?}");
                for pair in levels[1..].windows(2) {
                    assert!(pair[1] < pair[0], "{rate}: {levels:?}");
                }
                assert!(levels[levels.len() - 1] < levels[0] * 1e-2, "{levels:?}");
            }
        }
    }

    #[test]
    fn mono_and_stereo_of_the_same_sound_match() {
        let settings = Settings {
            room_size: 0.5,
            damping: 0.3,
            width: 1.0,
            mix: 0.5,
        };
        let sound: Vec<f32> = (0..20_000).map(|n| ((n as f32) * 0.05).sin()).collect();
        let mut mono = vec![sound.clone()];
        Reverb::new(settings, 48_000.0, 1).process(&mut mono);
        let mut stereo = vec![sound.clone(), sound];
        Reverb::new(settings, 48_000.0, 2).process(&mut stereo);
        // Same level, not the same samples: the right side's delays differ.
        let (a, b) = (rms(&mono[0]), rms(&stereo[0]));
        assert!((a / b - 1.0).abs() < 0.2, "{a} {b}");
    }
}
