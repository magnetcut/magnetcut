// The WAV files, the providers' requests and answers against a server here
// (no network, no real keys), and the system's voices.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::{self, JoinHandle};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};

#[cfg(not(target_os = "linux"))]
use super::espeak::parse_voices as espeak_voices;
#[cfg(target_os = "linux")]
use super::system::parse_voices as espeak_voices;
use super::{elevenlabs, error_message, openai, wav};

const KEY: &str = "test-key";

/// A request as the server here received it.
struct Received {
    method: String,
    /// With its query.
    path: String,
    /// By lowercase name.
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Received {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("a JSON body")
    }
}

/// Serves one request, answering with the status and body: the address to
/// send it to, and the request once it's in.
fn serve(
    status: u16,
    content_type: &str,
    body: impl Into<Vec<u8>>,
) -> (String, JoinHandle<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let content_type = content_type.to_owned();
    let body = body.into();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut data = Vec::new();
        let mut buffer = [0; 4096];
        let head_end = loop {
            let read = stream.read(&mut buffer).unwrap();
            assert!(read > 0, "the request ended early");
            data.extend_from_slice(&buffer[..read]);
            if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                break end;
            }
        };
        let head = String::from_utf8(data[..head_end].to_vec()).unwrap();
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next().unwrap().split(' ');
        let method = request_line.next().unwrap().to_owned();
        let path = request_line.next().unwrap().to_owned();
        let headers: HashMap<String, String> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        let length: usize = headers
            .get("content-length")
            .map_or(0, |length| length.parse().unwrap());
        let mut request_body = data[head_end + 4..].to_vec();
        while request_body.len() < length {
            let read = stream.read(&mut buffer).unwrap();
            assert!(read > 0, "the body ended early");
            request_body.extend_from_slice(&buffer[..read]);
        }
        let reason = StatusCode::from_u16(status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("");
        let answer = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(answer.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
        Received {
            method,
            path,
            headers,
            body: request_body,
        }
    });
    (base, server)
}

fn serve_json(status: u16, body: Value) -> (String, JoinHandle<Received>) {
    serve(status, "application/json", body.to_string())
}

fn client() -> Client {
    super::client_builder().no_proxy().build().unwrap()
}

fn run<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn u16_at(file: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([file[at], file[at + 1]])
}

fn u32_at(file: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(file[at..at + 4].try_into().unwrap())
}

#[test]
fn wav_header() {
    // Two samples and an odd byte, which is dropped.
    let file = wav::from_pcm(24_000, &[1, 0, 0xff, 0x7f, 9]);
    assert_eq!(file.len(), 48);
    assert_eq!(&file[0..4], b"RIFF");
    assert_eq!(u32_at(&file, 4), 40, "the file's size after these 8 bytes");
    assert_eq!(&file[8..16], b"WAVEfmt ");
    assert_eq!(u32_at(&file, 16), 16);
    assert_eq!(u16_at(&file, 20), 1, "PCM");
    assert_eq!(u16_at(&file, 22), 1, "mono");
    assert_eq!(u32_at(&file, 24), 24_000);
    assert_eq!(u32_at(&file, 28), 48_000, "bytes a second");
    assert_eq!(u16_at(&file, 32), 2, "bytes a frame");
    assert_eq!(u16_at(&file, 34), 16, "bits a sample");
    assert_eq!(&file[36..40], b"data");
    assert_eq!(u32_at(&file, 40), 4);
    assert_eq!(&file[44..], &[1, 0, 0xff, 0x7f]);
    assert!(!wav::is_empty(&file));
    assert!(wav::is_empty(&wav::from_pcm(24_000, &[])));
}

#[test]
fn wav_read_back() {
    let samples = [0, 1, -1, i16::MAX, i16::MIN, 1234];
    let file = wav::from_samples(22_050, &samples);
    assert_eq!(wav::read(&file).unwrap(), (22_050, samples.to_vec()));
}

/// A RIFF chunk, padded to an even size.
fn chunk(id: &[u8; 4], size: u32, data: &[u8]) -> Vec<u8> {
    let mut chunk = [id.as_slice(), &size.to_le_bytes(), data].concat();
    if data.len() % 2 == 1 {
        chunk.push(0);
    }
    chunk
}

fn fmt(tag: u16, channels: u16, sample_rate: u32, bits: u16, extra: &[u8]) -> Vec<u8> {
    let width = u32::from(bits / 8) * u32::from(channels);
    let mut data = Vec::new();
    data.extend_from_slice(&tag.to_le_bytes());
    data.extend_from_slice(&channels.to_le_bytes());
    data.extend_from_slice(&sample_rate.to_le_bytes());
    data.extend_from_slice(&(sample_rate * width).to_le_bytes());
    data.extend_from_slice(&(width as u16).to_le_bytes());
    data.extend_from_slice(&bits.to_le_bytes());
    data.extend_from_slice(extra);
    chunk(b"fmt ", data.len() as u32, &data)
}

fn riff(chunks: &[Vec<u8>], size: u32) -> Vec<u8> {
    [
        b"RIFF".as_slice(),
        &size.to_le_bytes(),
        b"WAVE",
        &chunks.concat(),
    ]
    .concat()
}

#[test]
fn wav_read_from_a_pipe() {
    // As espeak-ng writes to stdout: sizes it can't know, and a chunk with an
    // odd size before the samples.
    let samples: Vec<u8> = [100i16, -100, 2000]
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();
    let file = riff(
        &[
            fmt(1, 1, 22_050, 16, &[]),
            chunk(b"LIST", 3, b"abc"),
            [b"data".as_slice(), &0x7fff_ffffu32.to_le_bytes(), &samples].concat(),
        ],
        0x7fff_ffff,
    );
    assert_eq!(wav::read(&file).unwrap(), (22_050, vec![100, -100, 2000]));
}

#[test]
fn wav_read_mixes_float_stereo() {
    // WAVE_FORMAT_EXTENSIBLE, its subformat float.
    let mut extra = vec![22, 0, 32, 0, 3, 0, 0, 0];
    extra.extend_from_slice(&[
        3, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71,
    ]);
    let frames: Vec<u8> = [0.5f32, 0.0, -1.0, -1.0]
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();
    let file = riff(
        &[
            fmt(0xfffe, 2, 48_000, 32, &extra),
            chunk(b"data", 16, &frames),
        ],
        0,
    );
    assert_eq!(wav::read(&file).unwrap(), (48_000, vec![8192, -32768]));
}

#[test]
fn wav_read_refuses_others() {
    assert!(wav::read(b"not a wav file at all").is_err());
    let eight_bit = riff(&[fmt(1, 1, 8_000, 8, &[]), chunk(b"data", 2, &[1, 2])], 0);
    assert!(wav::read(&eight_bit).unwrap_err().contains("not read here"));
}

#[test]
fn elevenlabs_voices() {
    let (base, server) = serve_json(
        200,
        json!({ "voices": [
            {
                "voice_id": "21m00Tcm4TlvDq8ikWAM",
                "name": "Rachel",
                "category": "premade",
                "description": "Matter-of-fact, personable woman.",
                "labels": { "accent": "american", "gender": "female", "language": "en" },
                "preview_url": "https://example.com/rachel.mp3"
            },
            {
                "voice_id": "pqHfZKP75CvOlQylNhV4",
                "name": "Bill",
                "description": null,
                "labels": { "accent": "american", "age": "old", "gender": "male" },
                "verified_languages": [{ "language": "en", "model_id": "eleven_v2", "locale": "en-US" }]
            },
            { "voice_id": "bare", "name": "", "labels": null }
        ]}),
    );
    let voices = run(elevenlabs::voices(&client(), &base, KEY)).unwrap();
    let request = server.join().unwrap();
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/v1/voices");
    assert_eq!(request.headers["xi-api-key"], KEY);
    assert!(!request.headers.contains_key("authorization"));

    let voices = serde_json::to_value(voices).unwrap();
    assert_eq!(
        voices,
        json!([
            {
                "id": "21m00Tcm4TlvDq8ikWAM",
                "name": "Rachel",
                "language": "en",
                "description": "Matter-of-fact, personable woman."
            },
            {
                "id": "pqHfZKP75CvOlQylNhV4",
                "name": "Bill",
                "language": "en",
                "description": "american, old, male"
            },
            { "id": "bare", "name": "bare", "language": null, "description": null }
        ])
    );
}

#[test]
fn elevenlabs_models() {
    let (base, server) = serve_json(
        200,
        json!([
            { "model_id": "eleven_multilingual_v2", "name": "Eleven Multilingual v2", "can_do_text_to_speech": true, "languages": [] },
            { "model_id": "eleven_multilingual_sts_v2", "name": "Eleven Multilingual v2 (STS)", "can_do_text_to_speech": false },
            { "model_id": "eleven_flash_v2_5", "name": "Eleven Flash v2.5", "can_do_text_to_speech": true }
        ]),
    );
    let models = run(elevenlabs::models(&client(), &base, KEY)).unwrap();
    let request = server.join().unwrap();
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/v1/models")
    );
    assert_eq!(request.headers["xi-api-key"], KEY);
    assert_eq!(
        serde_json::to_value(models).unwrap(),
        json!([
            { "id": "eleven_multilingual_v2", "name": "Eleven Multilingual v2" },
            { "id": "eleven_flash_v2_5", "name": "Eleven Flash v2.5" }
        ])
    );
}

#[test]
fn elevenlabs_quota() {
    let (base, server) = serve_json(
        200,
        json!({ "tier": "starter", "character_count": 1234, "character_limit": 30000, "status": "active" }),
    );
    let quota = run(elevenlabs::quota(&client(), &base, KEY)).unwrap();
    let request = server.join().unwrap();
    assert_eq!(request.path, "/v1/user/subscription");
    assert_eq!(request.headers["xi-api-key"], KEY);
    assert_eq!(
        serde_json::to_value(quota).unwrap(),
        json!({ "used": 1234, "limit": 30000 })
    );
}

#[test]
fn elevenlabs_speak() {
    let pcm = vec![1u8, 0, 2, 0, 3, 0];
    let (base, server) = serve(200, "audio/pcm", pcm.clone());
    let request = elevenlabs::Speak {
        text: "Hello there.",
        voice: "a voice/id",
        model: Some("eleven_flash_v2_5"),
    };
    let spoken = run(elevenlabs::speak(&client(), &base, KEY, request)).unwrap();
    assert_eq!(spoken, pcm);
    let received = server.join().unwrap();
    assert_eq!(received.method, "POST");
    assert_eq!(
        received.path,
        "/v1/text-to-speech/a%20voice%2Fid?output_format=pcm_24000"
    );
    assert_eq!(received.headers["xi-api-key"], KEY);
    assert_eq!(received.headers["content-type"], "application/json");
    assert_eq!(
        received.json(),
        json!({ "text": "Hello there.", "model_id": "eleven_flash_v2_5" })
    );

    // Its default model, with none.
    let (base, server) = serve(200, "audio/pcm", pcm);
    let request = elevenlabs::Speak {
        text: "Hi.",
        voice: "abc",
        model: None,
    };
    run(elevenlabs::speak(&client(), &base, KEY, request)).unwrap();
    assert_eq!(server.join().unwrap().json(), json!({ "text": "Hi." }));
}

#[test]
fn elevenlabs_errors() {
    let (base, server) = serve_json(
        401,
        json!({ "detail": { "status": "invalid_api_key", "message": "Invalid API key" } }),
    );
    let error = run(elevenlabs::quota(&client(), &base, "wrong")).unwrap_err();
    server.join().unwrap();
    assert_eq!(error, "Invalid API key");

    let (base, server) = serve_json(
        401,
        json!({ "detail": { "status": "quota_exceeded", "message": "This request exceeds your quota of 10000. You have 12 credits remaining, while 40 credits are required for this request." } }),
    );
    let request = elevenlabs::Speak {
        text: "Too much.",
        voice: "abc",
        model: None,
    };
    let error = run(elevenlabs::speak(&client(), &base, KEY, request)).unwrap_err();
    server.join().unwrap();
    assert!(
        error.starts_with("This request exceeds your quota"),
        "{error}"
    );

    let (base, server) = serve_json(
        422,
        json!({ "detail": [{ "loc": ["body", "text"], "msg": "Field required", "type": "missing" }] }),
    );
    let error = run(elevenlabs::voices(&client(), &base, KEY)).unwrap_err();
    server.join().unwrap();
    assert_eq!(error, "Field required");
}

#[test]
fn openai_voices() {
    let voices = openai::voices();
    let ids: Vec<&str> = voices.iter().map(|voice| voice.id.as_str()).collect();
    assert!(ids.contains(&"alloy") && ids.contains(&"marin"));
    let marin = voices.iter().find(|voice| voice.id == "marin").unwrap();
    assert_eq!(marin.name, "Marin");
    assert!(marin.description.is_some());
    let alloy = voices.iter().find(|voice| voice.id == "alloy").unwrap();
    assert!(alloy.description.is_none());
}

#[test]
fn openai_models() {
    let (base, server) = serve_json(
        200,
        json!({ "object": "list", "data": [
            { "id": "gpt-4o", "object": "model", "created": 1, "owned_by": "system" },
            { "id": "tts-1-hd", "object": "model", "created": 1, "owned_by": "system" },
            { "id": "gpt-4o-mini-tts", "object": "model", "created": 1, "owned_by": "system" },
            { "id": "whisper-1", "object": "model", "created": 1, "owned_by": "openai-internal" },
            { "id": "tts-1", "object": "model", "created": 1, "owned_by": "openai-internal" }
        ]}),
    );
    let models = run(openai::models(&client(), &base, KEY)).unwrap();
    let request = server.join().unwrap();
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/v1/models")
    );
    assert_eq!(request.headers["authorization"], format!("Bearer {KEY}"));
    assert!(!request.headers.contains_key("xi-api-key"));
    let ids: Vec<String> = models.into_iter().map(|model| model.id).collect();
    assert_eq!(ids, ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);
}

#[test]
fn openai_speak() {
    let pcm = vec![5u8, 0, 6, 0];
    let (base, server) = serve(200, "application/octet-stream", pcm.clone());
    let request = openai::Speak {
        text: "Good evening.",
        voice: "coral",
        model: Some("gpt-4o-mini-tts"),
        instructions: Some("Calm, warm."),
    };
    let spoken = run(openai::speak(&client(), &base, KEY, request)).unwrap();
    assert_eq!(spoken, pcm);
    let received = server.join().unwrap();
    assert_eq!(received.method, "POST");
    assert_eq!(received.path, "/v1/audio/speech");
    assert_eq!(received.headers["authorization"], format!("Bearer {KEY}"));
    assert_eq!(received.headers["content-type"], "application/json");
    assert_eq!(
        received.json(),
        json!({
            "model": "gpt-4o-mini-tts",
            "voice": "coral",
            "input": "Good evening.",
            "response_format": "pcm",
            "instructions": "Calm, warm."
        })
    );

    // No instructions unless given; the default model with none.
    let (base, server) = serve(200, "application/octet-stream", pcm);
    let request = openai::Speak {
        text: "Hi.",
        voice: "alloy",
        model: None,
        instructions: None,
    };
    run(openai::speak(&client(), &base, KEY, request)).unwrap();
    assert_eq!(
        server.join().unwrap().json(),
        json!({ "model": "gpt-4o-mini-tts", "voice": "alloy", "input": "Hi.", "response_format": "pcm" })
    );
}

#[test]
fn openai_errors() {
    let (base, server) = serve_json(
        401,
        json!({ "error": {
            "message": "Incorrect API key provided: wrong. You can find your API key at https://platform.openai.com/account/api-keys.",
            "type": "invalid_request_error", "param": null, "code": "invalid_api_key"
        }}),
    );
    let error = run(openai::models(&client(), &base, "wrong")).unwrap_err();
    server.join().unwrap();
    assert!(error.starts_with("Incorrect API key provided"), "{error}");

    let (base, server) = serve_json(
        429,
        json!({ "error": { "message": "You exceeded your current quota, please check your plan and billing details.", "type": "insufficient_quota", "param": null, "code": "insufficient_quota" } }),
    );
    let request = openai::Speak {
        text: "Hi.",
        voice: "alloy",
        model: None,
        instructions: None,
    };
    let error = run(openai::speak(&client(), &base, KEY, request)).unwrap_err();
    server.join().unwrap();
    assert!(
        error.starts_with("You exceeded your current quota"),
        "{error}"
    );
}

#[test]
fn errors_without_a_message() {
    let bad_gateway = StatusCode::BAD_GATEWAY;
    assert_eq!(error_message(bad_gateway, b""), "502 Bad Gateway");
    assert_eq!(
        error_message(bad_gateway, b"<html><body>Bad gateway</body></html>"),
        "502 Bad Gateway"
    );
    assert_eq!(
        error_message(StatusCode::NOT_FOUND, b"voice not found"),
        "404 Not Found: voice not found"
    );
    assert_eq!(
        error_message(StatusCode::BAD_REQUEST, br#"{"detail": "A plain detail."}"#),
        "A plain detail."
    );
    assert_eq!(
        error_message(StatusCode::BAD_REQUEST, br#"{"error": "Just a string"}"#),
        "Just a string"
    );
    // Not one of the shapes known: the status.
    assert_eq!(
        error_message(StatusCode::BAD_REQUEST, br#"{"oops": 1}"#),
        "400 Bad Request: {\"oops\": 1}"
    );
}

#[test]
fn unreachable_provider() {
    // A port nothing listens on.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let base = format!("http://127.0.0.1:{port}");
    let error = run(elevenlabs::voices(&client(), &base, KEY)).unwrap_err();
    assert!(error.starts_with("Can't reach 127.0.0.1: "), "{error}");
    assert!(!error.contains(KEY));
}

#[test]
fn espeak_voice_list() {
    let listing = "\
Pty Language       Age/Gender VoiceName          File                 Other Languages
 5  af              --/M      Afrikaans          gmw/af
 2  en-gb           --/M      English_(Great_Britain) gmw/en               (en 2)
 5  en-us           --/M      English_(America)  gmw/en-US            (en 3)
 5  en-us           --/M      English_(America)_again gmw/en-US-2
 5  fr-fr           --/M      French_(France)    roa/fr               (fr 5)

";
    let voices = serde_json::to_value(espeak_voices(listing)).unwrap();
    assert_eq!(
        voices,
        json!([
            { "id": "af", "name": "Afrikaans", "language": "af", "description": null },
            { "id": "en-gb", "name": "English (Great Britain)", "language": "en-gb", "description": null },
            { "id": "en-us", "name": "English (America)", "language": "en-us", "description": null },
            { "id": "fr-fr", "name": "French (France)", "language": "fr-fr", "description": null }
        ])
    );
}

/// The voices only: AVSpeechSynthesizer hands its speech to the main
/// thread, which the test harness keeps (src/speech/avspeech.rs reads its
/// buffers in a test of its own).
#[cfg(target_os = "macos")]
#[test]
fn mac_voices() {
    let voices = super::system::voices().unwrap();
    assert!(!voices.is_empty());
    assert!(
        voices
            .iter()
            .all(|voice| !voice.id.is_empty() && !voice.name.is_empty())
    );
    assert!(voices.iter().any(|voice| {
        voice
            .language
            .as_deref()
            .is_some_and(|tag| tag.starts_with("en"))
    }));
}
