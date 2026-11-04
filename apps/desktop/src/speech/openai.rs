// OpenAI's speech endpoint (developers.openai.com/api/docs/guides/text-to-speech):
// its text-to-speech models as it lists them, its voices, and speech as raw
// samples at 24 kHz.

use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::{Model, Voice, endpoint, fetch_bytes, fetch_json};

pub const BASE: &str = "https://api.openai.com";
pub const SAMPLE_RATE: u32 = 24_000;
/// The model when none is picked: the one that takes instructions.
const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";

/// Its voices, which no endpoint lists. tts-1 and tts-1-hd have all but the
/// last four.
const VOICES: &[&str] = &[
    "alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "ballad", "verse",
    "marin", "cedar",
];
const NOT_IN_TTS_1: &[&str] = &["ballad", "verse", "marin", "cedar"];

pub fn voices() -> Vec<Voice> {
    VOICES
        .iter()
        .map(|&id| {
            let mut name = id.to_owned();
            name[..1].make_ascii_uppercase();
            Voice {
                id: id.to_owned(),
                name,
                // It speaks the text's language.
                language: None,
                description: NOT_IN_TTS_1
                    .contains(&id)
                    .then(|| "Not with tts-1 or tts-1-hd".to_owned()),
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// The models the key can use that speak: those with "tts" in their name.
pub async fn models(client: &Client, base: &str, key: &str) -> Result<Vec<Model>, String> {
    let url = endpoint(base, &["v1", "models"])?;
    let list: ModelList = fetch_json(client.get(url).bearer_auth(key)).await?;
    let mut ids: Vec<String> = list
        .data
        .into_iter()
        .map(|model| model.id)
        .filter(|id| id.contains("tts"))
        .collect();
    ids.sort();
    Ok(ids
        .into_iter()
        .map(|id| Model {
            name: id.clone(),
            id,
        })
        .collect())
}

pub struct Speak<'a> {
    pub text: &'a str,
    pub voice: &'a str,
    pub model: Option<&'a str>,
    /// How it's spoken ("calm, warm"): sent only if given.
    pub instructions: Option<&'a str>,
}

/// The text spoken: 16-bit mono samples at 24 kHz, little-endian.
pub async fn speak(
    client: &Client,
    base: &str,
    key: &str,
    request: Speak<'_>,
) -> Result<Vec<u8>, String> {
    let url = endpoint(base, &["v1", "audio", "speech"])?;
    let mut body = json!({
        "model": request.model.unwrap_or(DEFAULT_MODEL),
        "voice": request.voice,
        "input": request.text,
        "response_format": "pcm",
    });
    if let Some(instructions) = request.instructions {
        body["instructions"] = instructions.into();
    }
    fetch_bytes(client.post(url).bearer_auth(key).json(&body)).await
}
