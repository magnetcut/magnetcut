// WAV files of 16-bit mono samples: what every voice gives the editor.

const HEADER: usize = 44;

/// A WAV file of 16-bit mono samples, given as little-endian bytes (an odd
/// last byte is dropped).
pub fn from_pcm(sample_rate: u32, pcm: &[u8]) -> Vec<u8> {
    // The sizes are 32-bit: hours of speech, more than any cue.
    let length = pcm.len().min(u32::MAX as usize - HEADER) & !1;
    let size = |extra: usize| ((length + extra) as u32).to_le_bytes();
    let mut file = Vec::with_capacity(HEADER + length);
    file.extend_from_slice(b"RIFF");
    file.extend_from_slice(&size(HEADER - 8));
    file.extend_from_slice(b"WAVE");
    file.extend_from_slice(b"fmt ");
    file.extend_from_slice(&16u32.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes()); // PCM
    file.extend_from_slice(&1u16.to_le_bytes()); // mono
    file.extend_from_slice(&sample_rate.to_le_bytes());
    file.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // bytes a second
    file.extend_from_slice(&2u16.to_le_bytes()); // bytes a frame
    file.extend_from_slice(&16u16.to_le_bytes()); // bits a sample
    file.extend_from_slice(b"data");
    file.extend_from_slice(&size(0));
    file.extend_from_slice(&pcm[..length]);
    file
}

pub fn from_samples(sample_rate: u32, samples: &[i16]) -> Vec<u8> {
    let pcm: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    from_pcm(sample_rate, &pcm)
}

/// Whether a file made here has no samples.
pub fn is_empty(file: &[u8]) -> bool {
    file.len() <= HEADER
}

/// The sample rate and samples of a WAV file the system made, in 16-bit PCM
/// or 32-bit float, its channels mixed to one. espeak-ng, writing to a pipe,
/// can't go back to fill in the sizes: a chunk runs at most to the end.
#[cfg(any(test, not(target_os = "macos")))]
pub fn read(file: &[u8]) -> Result<(u32, Vec<i16>), String> {
    let not_wav = || "not a WAV file".to_owned();
    if file.len() < 12 || &file[..4] != b"RIFF" || &file[8..12] != b"WAVE" {
        return Err(not_wav());
    }
    let u16_at = |chunk: &[u8], at: usize| u16::from_le_bytes([chunk[at], chunk[at + 1]]);
    let u32_at = |chunk: &[u8], at: usize| {
        u32::from_le_bytes([chunk[at], chunk[at + 1], chunk[at + 2], chunk[at + 3]])
    };
    // (format tag, channels, sample rate, bits a sample)
    let mut format = None;
    let mut position = 12;
    while position + 8 <= file.len() {
        let id = &file[position..position + 4];
        let start = position + 8;
        let end = start
            .saturating_add(u32_at(file, position + 4) as usize)
            .min(file.len());
        let chunk = &file[start..end];
        if id == b"fmt " && chunk.len() >= 16 {
            let mut tag = u16_at(chunk, 0);
            // WAVE_FORMAT_EXTENSIBLE: the tag is the subformat's first two bytes.
            if tag == 0xFFFE && chunk.len() >= 26 {
                tag = u16_at(chunk, 24);
            }
            format = Some((tag, u16_at(chunk, 2), u32_at(chunk, 4), u16_at(chunk, 14)));
        } else if id == b"data" {
            let (tag, channels, sample_rate, bits) = format.ok_or_else(not_wav)?;
            let channels = usize::from(channels.max(1));
            let samples = match (tag, bits) {
                (1, 16) => mix(chunk, 2, channels, |bytes| {
                    f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32768.0
                }),
                (3, 32) => mix(chunk, 4, channels, |bytes| {
                    f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
                }),
                _ => {
                    return Err(format!(
                        "a WAV file in a format not read here ({tag}, {bits} bits)"
                    ));
                }
            };
            return Ok((sample_rate, samples));
        }
        // Chunks are padded to an even size.
        position = end + (end - start) % 2;
    }
    Err(not_wav())
}

/// Frames of `channels` samples of `width` bytes each, averaged to one.
#[cfg(any(test, not(target_os = "macos")))]
fn mix(data: &[u8], width: usize, channels: usize, sample: impl Fn(&[u8]) -> f32) -> Vec<i16> {
    data.chunks_exact(width * channels)
        .map(|frame| {
            let sum: f32 = frame.chunks_exact(width).map(&sample).sum();
            to_i16(sum / channels as f32)
        })
        .collect()
}

/// A sample from -1 to 1 as a 16-bit one.
pub fn to_i16(sample: f32) -> i16 {
    (sample * 32768.0).round().clamp(-32768.0, 32767.0) as i16
}
