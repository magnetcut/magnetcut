//! A feed-forward compressor (Giannoulis, Massberg and Reiss, "Digital
//! Dynamic Range Compressor Design", 2012): the level is the loudest channel's
//! peak, so the channels are turned down together and the stereo image holds;
//! a soft knee; the gain reduction smoothed in dB, quickly as it grows
//! (attack) and slowly as it shrinks (release).

use crate::settings::Compressor as Settings;

/// The knee's width, dB: the ratio comes in gradually over it.
const KNEE: f32 = 6.0;
/// dB of gain reduction under which it's taken as none.
const NONE: f32 = 1e-6;

pub(crate) struct Compressor {
    threshold: f32,
    /// 1 / ratio - 1: how much of the level over the threshold is taken off.
    slope: f32,
    /// Below this peak level (linear) the gain computer gives no reduction.
    knee_start: f32,
    attack: f32,
    release: f32,
    makeup: f32,
    /// The smoothed gain reduction, dB, 0 or more.
    reduction: f32,
}

impl Compressor {
    pub(crate) fn new(settings: Settings, sample_rate: f32) -> Compressor {
        // One-pole coefficients for time constants in milliseconds.
        let coefficient = |milliseconds: f32| (-1000.0 / (milliseconds * sample_rate)).exp();
        Compressor {
            threshold: settings.threshold,
            slope: 1.0 / settings.ratio - 1.0,
            knee_start: db_to_gain(settings.threshold - KNEE / 2.0),
            attack: coefficient(settings.attack),
            release: coefficient(settings.release),
            makeup: settings.makeup,
            reduction: 0.0,
        }
    }

    /// The gain reduction the gain computer asks for at a level, dB.
    fn target(&self, level_db: f32) -> f32 {
        let over = level_db - self.threshold;
        if 2.0 * over < -KNEE {
            0.0
        } else if 2.0 * over.abs() <= KNEE {
            let into = over + KNEE / 2.0;
            -self.slope * into * into / (2.0 * KNEE)
        } else {
            -self.slope * over
        }
    }

    pub(crate) fn process(&mut self, channels: &mut [Vec<f32>]) {
        let length = channels.first().map_or(0, Vec::len);
        let makeup = db_to_gain(self.makeup);
        for n in 0..length {
            let peak = channels
                .iter()
                .fold(0.0f32, |peak, channel| peak.max(channel[n].abs()));
            let target = if peak > self.knee_start {
                self.target(gain_to_db(peak))
            } else {
                0.0
            };
            let coefficient = if target > self.reduction {
                self.attack
            } else {
                self.release
            };
            self.reduction = target + coefficient * (self.reduction - target);
            if self.reduction < NONE {
                self.reduction = 0.0;
            }
            let gain = if self.reduction == 0.0 {
                makeup
            } else {
                db_to_gain(self.makeup - self.reduction)
            };
            for channel in channels.iter_mut() {
                channel[n] *= gain;
            }
        }
    }

    /// How many dB it's turning the sound down by now: for a meter.
    #[cfg(test)]
    pub(crate) fn reduction(&self) -> f32 {
        self.reduction
    }
}

fn db_to_gain(db: f32) -> f32 {
    (db * (std::f32::consts::LN_10 / 20.0)).exp()
}

fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn settings(threshold: f32, ratio: f32) -> Settings {
        Settings {
            threshold,
            ratio,
            attack: 5.0,
            release: 100.0,
            makeup: 0.0,
        }
    }

    #[test]
    fn the_knee_joins_up() {
        let compressor = Compressor::new(settings(-20.0, 4.0), RATE);
        assert_eq!(compressor.target(-30.0), 0.0);
        assert!(compressor.target(-23.0).abs() < 1e-6);
        assert!((compressor.target(-17.0) - 3.0 * 0.75).abs() < 1e-4);
        assert!((compressor.target(0.0) - 15.0).abs() < 1e-4);
    }

    #[test]
    fn a_step_is_turned_down_at_the_attack_rate() {
        let mut compressor = Compressor::new(settings(-20.0, 4.0), RATE);
        // 5 ms in, a one-pole has gone 1 - 1/e of the way.
        let mut step = vec![vec![1.0f32; (RATE * 0.005) as usize]];
        compressor.process(&mut step);
        let expected = 15.0 * (1.0 - (-1.0f32).exp());
        assert!((compressor.reduction() - expected).abs() < 0.05);
    }
}
