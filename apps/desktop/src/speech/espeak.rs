// The voices on a Linux computer: espeak-ng's, run as a program of its own
// (it's GPL, and isn't linked). It's in every distribution's packages, though
// not always installed.

use std::io::{ErrorKind, Write};
use std::process::{Command, Stdio};

use super::{Voice, wav};

const PROGRAM: &str = "espeak-ng";
const MISSING: &str = "Install espeak-ng for voices on this computer.";

/// Runs espeak-ng with the arguments, giving it the input: what it writes.
fn run(arguments: &[&str], input: &str) -> Result<Vec<u8>, String> {
    let mut child = Command::new(PROGRAM)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            ErrorKind::NotFound => MISSING.to_owned(),
            _ => format!("{PROGRAM}: {error}"),
        })?;
    // Written from a thread of its own, so that neither waits on the other
    // with a pipe full.
    let mut stdin = child.stdin.take().ok_or("no pipe to espeak-ng")?;
    let input = input.to_owned();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let _ = writer.join();
    if !output.status.success() {
        let errors = String::from_utf8_lossy(&output.stderr);
        let errors = errors.trim();
        if errors.is_empty() {
            return Err(format!("{PROGRAM} failed ({})", output.status));
        }
        return Err(format!("{PROGRAM}: {errors}"));
    }
    Ok(output.stdout)
}

pub fn voices() -> Result<Vec<Voice>, String> {
    let listing = run(&["--voices"], "")?;
    Ok(parse_voices(&String::from_utf8_lossy(&listing)))
}

/// `espeak-ng --voices`: a header, then a line for each language, as
/// " 5  en-gb  --/M  English_(Great_Britain)  gmw/en  (en 2)". The language
/// is what -v takes.
pub fn parse_voices(listing: &str) -> Vec<Voice> {
    let mut voices: Vec<Voice> = Vec::new();
    for line in listing.lines().skip(1) {
        let columns: Vec<&str> = line.split_whitespace().collect();
        let [_priority, language, _gender, name, ..] = columns[..] else {
            continue;
        };
        if voices.iter().any(|voice| voice.id == language) {
            continue;
        }
        voices.push(Voice {
            id: language.to_owned(),
            name: name.replace('_', " "),
            language: Some(language.to_owned()),
            description: None,
        });
    }
    voices
}

/// The text spoken by the voice for this language (espeak-ng's default for
/// none), as a WAV file. The text goes in on stdin, in UTF-8, so that none
/// of it is read as an option.
pub fn speak(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let mut arguments = vec!["--stdout", "-b", "1"];
    if !voice.is_empty() {
        arguments.extend(["-v", voice]);
    }
    arguments.push("--stdin");
    let file = run(&arguments, text)?;
    let (sample_rate, samples) = wav::read(&file)?;
    Ok(wav::from_samples(sample_rate, &samples))
}
