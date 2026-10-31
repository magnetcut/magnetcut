// Agent mode from the command line (docs/AUTOMATION.md, phase 4):
// `magnetcut --mcp`, MCP on standard input and output, each message relayed
// to the app's server as it comes; and `magnetcut call <tool> ['<json>']`,
// one tool call, its text printed. Both with the agent's token in
// MAGNETCUT_TOKEN and the server's address in MAGNETCUT_URL (Settings gives
// both); the app is started if it isn't running.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const DEFAULT_URL: &str = "http://127.0.0.1:47213/mcp";

// How long the app may take to start and serve.
const START_TIMEOUT: Duration = Duration::from_secs(90);

pub(super) struct Server {
    address: String,
    path: String,
    token: String,
}

impl Server {
    #[cfg(test)]
    pub(super) fn new(address: &str, path: &str, token: &str) -> Self {
        Self {
            address: address.to_owned(),
            path: path.to_owned(),
            token: token.to_owned(),
        }
    }

    fn from_env() -> Result<Self, String> {
        let token = std::env::var("MAGNETCUT_TOKEN")
            .map_err(|_| "MAGNETCUT_TOKEN isn't set: an agent's token, from Settings, Agents")?;
        let url = std::env::var("MAGNETCUT_URL").unwrap_or_else(|_| DEFAULT_URL.into());
        let rest = url
            .strip_prefix("http://")
            .ok_or("MAGNETCUT_URL is http://127.0.0.1:<port>/mcp")?;
        let (address, path) = rest.split_once('/').unwrap_or((rest, "mcp"));
        Ok(Self {
            address: address.to_owned(),
            path: format!("/{path}"),
            token,
        })
    }

    /// Connected, the app started first if nothing answers.
    fn connect(&self) -> Result<TcpStream, String> {
        if let Ok(stream) = TcpStream::connect(&self.address) {
            return Ok(stream);
        }
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        Command::new(exe)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Couldn't start MagnetCut: {error}"))?;
        let started = Instant::now();
        while started.elapsed() < START_TIMEOUT {
            thread::sleep(Duration::from_millis(500));
            if let Ok(stream) = TcpStream::connect(&self.address) {
                return Ok(stream);
            }
        }
        Err("MagnetCut isn't serving agents: switch on Settings, Let agents use MagnetCut".into())
    }

    /// Posts one JSON-RPC message; each message of the reply, as it comes.
    pub(super) fn post(&self, body: &str, mut each: impl FnMut(Value)) -> Result<(), String> {
        let mut stream = self.connect()?;
        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
            self.path,
            self.address,
            self.token,
            body.len()
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        let status: u16 = line
            .split_whitespace()
            .nth(1)
            .and_then(|status| status.parse().ok())
            .unwrap_or(0);
        let mut events = false;
        loop {
            line.clear();
            reader
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            let header = line.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.eq_ignore_ascii_case("content-type")
            {
                events = value.contains("text/event-stream");
            }
        }
        match status {
            200 => {}
            202 => return Ok(()),
            401 => return Err("The token isn't one of MagnetCut's agents".into()),
            403 => return Err("MagnetCut refused the request".into()),
            other => return Err(format!("MagnetCut answered {other}")),
        }
        if events {
            for line in reader.lines() {
                let line = line.map_err(|error| error.to_string())?;
                if let Some(data) = line.strip_prefix("data: ")
                    && let Ok(message) = serde_json::from_str(data)
                {
                    each(message);
                }
            }
        } else {
            let mut body = String::new();
            reader
                .read_to_string(&mut body)
                .map_err(|error| error.to_string())?;
            if let Ok(message) = serde_json::from_str(&body) {
                each(message);
            }
        }
        Ok(())
    }
}

/// MCP on standard input and output: each line a message, relayed; each
/// message back a line. Requests in flight at once each have their thread.
fn relay(server: Server) -> i32 {
    let server = Arc::new(server);
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let mut threads = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (server, out) = (Arc::clone(&server), Arc::clone(&out));
        threads.push(thread::spawn(move || {
            let id = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|message| message.get("id").cloned());
            let write = |message: &Value| {
                let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
                let _ = writeln!(out, "{message}");
                let _ = out.flush();
            };
            if let Err(error) = server.post(&line, |message| write(&message)) {
                // A request answered with the failure; a notification, said on
                // standard error.
                match id {
                    Some(id) => write(&json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32000, "message": error },
                    })),
                    None => eprintln!("magnetcut: {error}"),
                }
            }
        }));
    }
    for thread in threads {
        let _ = thread.join();
    }
    0
}

/// One tool call: its text printed (an image as a note of it).
fn call(server: Server, tool: &str, arguments: Option<&str>) -> i32 {
    let arguments: Value = match arguments.map(serde_json::from_str).transpose() {
        Ok(arguments) => arguments.unwrap_or_else(|| json!({})),
        Err(error) => {
            eprintln!("magnetcut: the arguments aren't JSON: {error}");
            return 2;
        }
    };
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": tool, "arguments": arguments } })
    .to_string();
    let mut code = 1;
    let result = server.post(&body, |message| {
        let Some(result) = message.get("result") else {
            if let Some(error) = message.get("error") {
                eprintln!(
                    "magnetcut: {}",
                    error["message"].as_str().unwrap_or("failed")
                );
            }
            return;
        };
        for item in result["content"].as_array().into_iter().flatten() {
            match item["type"].as_str() {
                Some("text") => println!("{}", item["text"].as_str().unwrap_or("")),
                Some("image") => {
                    println!("[an image, {}]", item["mimeType"].as_str().unwrap_or(""))
                }
                _ => {}
            }
        }
        code = if result["isError"].as_bool() == Some(true) {
            1
        } else {
            0
        };
    });
    if let Err(error) = result {
        eprintln!("magnetcut: {error}");
        return 1;
    }
    code
}

/// Runs a command-line mode, if `args` asks for one: its exit code.
pub fn run(args: &[String]) -> Option<i32> {
    let mode = args.get(1)?.as_str();
    if mode != "--mcp" && mode != "call" {
        return None;
    }
    let server = match Server::from_env() {
        Ok(server) => server,
        Err(error) => {
            eprintln!("magnetcut: {error}");
            return Some(2);
        }
    };
    Some(match mode {
        "--mcp" => relay(server),
        _ => match args.get(2) {
            Some(tool) => call(server, tool, args.get(3).map(String::as_str)),
            None => {
                eprintln!("usage: magnetcut call <tool> ['<arguments as JSON>']");
                2
            }
        },
    })
}
