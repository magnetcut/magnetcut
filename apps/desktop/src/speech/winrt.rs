// Windows's own voices: WinRT's SpeechSynthesizer, which speaks into a WAV
// stream.

use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceInformation};
use windows::Storage::Streams::DataReader;
use windows::core::HSTRING;

use super::{Voice, wav};

fn failed(error: windows::core::Error) -> String {
    error.message()
}

fn voice(voice: &VoiceInformation) -> Result<Voice, windows::core::Error> {
    let description = voice.Description()?.to_string();
    Ok(Voice {
        id: voice.Id()?.to_string(),
        name: voice.DisplayName()?.to_string(),
        language: Some(voice.Language()?.to_string()),
        description: Some(description).filter(|description| !description.is_empty()),
    })
}

pub fn voices() -> Result<Vec<Voice>, String> {
    let voices = SpeechSynthesizer::AllVoices().map_err(failed)?;
    let mut voices = voices
        .into_iter()
        .map(|found| voice(&found))
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    voices.sort_by(|a, b| (&a.language, &a.name).cmp(&(&b.language, &b.name)));
    Ok(voices)
}

/// The text spoken by the voice with this id (the system's default for an
/// empty one), as a WAV file.
pub fn speak(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let synthesizer = SpeechSynthesizer::new().map_err(failed)?;
    if !voice.is_empty() {
        let found = SpeechSynthesizer::AllVoices()
            .map_err(failed)?
            .into_iter()
            .find(|found| found.Id().is_ok_and(|id| id == voice))
            .ok_or_else(|| format!("no voice {voice} on this computer"))?;
        synthesizer.SetVoice(&found).map_err(failed)?;
    }
    let stream = synthesizer
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))
        .and_then(|operation| operation.join())
        .map_err(failed)?;
    let size = u32::try_from(stream.Size().map_err(failed)?).map_err(|_| "too much speech")?;
    let reader = stream
        .GetInputStreamAt(0)
        .and_then(|input| DataReader::CreateDataReader(&input))
        .map_err(failed)?;
    reader
        .LoadAsync(size)
        .and_then(|operation| operation.join())
        .map_err(failed)?;
    let mut file = vec![0; size as usize];
    reader.ReadBytes(&mut file).map_err(failed)?;
    // As 16-bit mono, whatever the voice made.
    let (sample_rate, samples) = wav::read(&file)?;
    Ok(wav::from_samples(sample_rate, &samples))
}
