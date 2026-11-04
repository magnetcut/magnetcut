//! Reducing noise with RNNoise (Jean-Marc Valin's recurrent network, through
//! the nnnoiseless port). It's made for voices: it takes out steady noise
//! like fans and air well, white noise and hiss unevenly (from 1 to 20 dB,
//! depending on their level).
//!
//! It works on 10 ms frames at 48 kHz, on samples scaled as 16-bit integers,
//! and gives each frame back a frame later. Other rates are resampled to 48
//! kHz and back. Output comes in bursts, a frame at a time, so it's held in a
//! queue that starts with enough silence never to run dry: what goes in one
//! sample comes out one sample, a fixed number of samples later.

use std::collections::VecDeque;
use std::sync::OnceLock;

use nnnoiseless::{DenoiseState, RnnModel};

use crate::resample::Resampler;

const RATE: u32 = 48_000;
const FRAME: usize = DenoiseState::FRAME_SIZE;
/// RNNoise's input is 16-bit samples as floats.
const SCALE: f32 = 32_768.0;

/// The network's weights, read once and shared by every channel and clip.
fn model() -> &'static RnnModel {
    static MODEL: OnceLock<RnnModel> = OnceLock::new();
    MODEL.get_or_init(RnnModel::default)
}

struct Channel {
    to_network: Resampler,
    from_network: Resampler,
    network: Box<DenoiseState<'static>>,
    /// Samples at 48 kHz waiting for a whole frame.
    pending: Vec<f32>,
    /// Denoised samples back at the clip's rate, scratch.
    resampled: Vec<f32>,
    /// Denoised samples at the clip's rate, waiting to go out.
    ready: VecDeque<f32>,
    /// The original, delayed to line up with `ready`, to mix back in.
    original: VecDeque<f32>,
    /// For tests of the timing: in place of the network, the frame before.
    #[cfg(test)]
    held: Option<Vec<f32>>,
}

impl Channel {
    fn denoise_frame(&mut self, input: &[f32; FRAME], output: &mut [f32; FRAME]) {
        #[cfg(test)]
        if let Some(held) = &mut self.held {
            output.copy_from_slice(held);
            held.copy_from_slice(input);
            return;
        }
        self.network.process_frame(output, input);
    }
}

pub(crate) struct Denoise {
    strength: f32,
    latency: usize,
    channels: Vec<Channel>,
}

impl Denoise {
    pub(crate) fn new(strength: f32, sample_rate: u32, channels: usize) -> Denoise {
        let rate = sample_rate.max(1);
        let rate64 = i64::from(rate);
        let network_rate = i64::from(RATE);
        // RNNoise gives a frame back a frame later. Its delay at the clip's
        // rate, in whole samples: the resampling to 48 kHz starts this much
        // earlier to make up the fraction.
        let delay = (FRAME as u64 * u64::from(rate)).div_ceil(u64::from(RATE)) as i64;
        let offset = FRAME as i64 * rate64 - delay * network_rate;
        let mut kernels = (None, None);
        let channels: Vec<Channel> = (0..channels)
            .map(|_| {
                let to_network = Resampler::new(rate, RATE, offset, kernels.0.clone());
                let from_network = Resampler::new(RATE, rate, 0, kernels.1.clone());
                kernels = (to_network.kernel(), from_network.kernel());
                Channel {
                    to_network,
                    from_network,
                    network: DenoiseState::with_model(model()),
                    pending: Vec::with_capacity(2 * FRAME),
                    resampled: Vec::with_capacity(FRAME),
                    ready: VecDeque::new(),
                    original: VecDeque::new(),
                    #[cfg(test)]
                    held: None,
                }
            })
            .collect();
        let (lookahead_in, lookahead_out) = channels.first().map_or((0, 0), |channel| {
            (
                channel.to_network.lookahead() as i64,
                channel.from_network.lookahead() as i64,
            )
        });
        // The least latency that keeps the queue from running dry, even with
        // samples coming one at a time. A sample at the clip's rate needs the
        // 48 kHz output up to the second resampler's lookahead past it; that
        // comes out of RNNoise with the rest of its frame, a frame after it
        // went in: up to two frames less a sample later; and the 48 kHz input
        // for that needs the first resampler's lookahead at the clip's rate.
        let latency = (lookahead_out + 2 * FRAME as i64 - 1) * rate64 / network_rate + lookahead_in;
        let latency = latency.max(delay) as usize;
        let mut denoise = Denoise {
            strength,
            latency,
            channels,
        };
        for channel in &mut denoise.channels {
            channel
                .ready
                .extend(std::iter::repeat_n(0.0, latency - delay as usize));
            channel.original.extend(std::iter::repeat_n(0.0, latency));
        }
        denoise
    }

    pub(crate) fn latency(&self) -> usize {
        self.latency
    }

    pub(crate) fn process(&mut self, channels: &mut [Vec<f32>]) {
        let strength = self.strength;
        for (samples, channel) in channels.iter_mut().zip(&mut self.channels) {
            channel.to_network.process(samples, &mut channel.pending);
            let frames = channel.pending.len() / FRAME;
            let mut input = [0.0f32; FRAME];
            let mut denoised = [0.0f32; FRAME];
            for frame in 0..frames {
                let at = frame * FRAME;
                for (scaled, value) in input.iter_mut().zip(&channel.pending[at..at + FRAME]) {
                    *scaled = value * SCALE;
                }
                channel.denoise_frame(&input, &mut denoised);
                for value in &mut denoised {
                    *value /= SCALE;
                }
                channel
                    .from_network
                    .process(&denoised, &mut channel.resampled);
                channel.ready.extend(channel.resampled.drain(..));
            }
            channel.pending.drain(..frames * FRAME);

            debug_assert!(channel.ready.len() >= samples.len());
            for sample in samples.iter_mut() {
                channel.original.push_back(*sample);
                let original = channel.original.pop_front().unwrap_or(0.0);
                let denoised = channel.ready.pop_front().unwrap_or(0.0);
                *sample = original + strength * (denoised - original);
            }
        }
    }

    /// For tests of the timing: frames go through the 48 kHz side unchanged,
    /// a frame late as RNNoise gives them.
    #[cfg(test)]
    pub(crate) fn skip_network(&mut self) {
        for channel in &mut self.channels {
            channel.held = Some(vec![0.0; FRAME]);
        }
    }
}
