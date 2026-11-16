// One request to the agent server, answered: who's asking (a token that's one
// of the user's agents, then the Host and no Origin), then MCP's JSON-RPC.
// Tool calls go to the editor, which does the work; their progress comes back
// as server-sent events where the client takes them.

use std::net::TcpStream;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use serde_json::{Value, json};

use super::http::{self, Refusal};
use super::{Caller, Shared};

// The protocol versions spoken, the newest first.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

// How long a tool call may take before the agent's told the editor didn't
// answer: an export takes a while.
const CALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

// How long `tools/list` and a tool call wait for the editor to say what it
// can do, while the app starts or its page reloads.
const TOOLS_TIMEOUT: Duration = Duration::from_secs(15);

// What an agent is told, once, when it connects.
const INSTRUCTIONS: &str = "MagnetCut, a video editor, open on this computer. Read the project \
with `summary` (short; `describe` for one thing's detail), change it with `edit` (a batch is \
one undo), look with `look`, export with `export`. Times are seconds, m:ss.s or f<frame>. The \
user sees every change in the window and can stop you.";

fn json_reply(stream: &TcpStream, message: &Value) {
    http::respond(
        stream,
        200,
        "OK",
        &[],
        Some("application/json"),
        message.to_string().as_bytes(),
    );
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Whether `host` names this server: 127.0.0.1, on its port, as the lines
/// pasted say. A web page that reached it by another name (DNS rebinding)
/// doesn't.
fn is_own_host(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|host| host == format!("127.0.0.1:{port}"))
}

/// The token in an `Authorization` header: `Bearer`, in any case, then it.
fn bearer(value: &str) -> Option<&str> {
    let (scheme, token) = value.trim().split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
}

fn unauthorized(stream: &TcpStream) {
    http::refuse(
        stream,
        401,
        "Unauthorized",
        &[("WWW-Authenticate", "Bearer realm=\"MagnetCut\"")],
    );
}

/// Answers the request on `stream`, the server being on `port`.
pub fn handle(shared: &Shared, stream: &TcpStream, port: u16) {
    // Without a good token, 401 and nothing else: not even the body is read.
    let (mut request, mut reader) = match http::read_head(stream) {
        Ok(read) => read,
        Err(Refusal::Gone) => return,
        Err(Refusal::Status(..)) => {
            unauthorized(stream);
            return;
        }
    };
    let agent = request
        .header("Authorization")
        .and_then(bearer)
        .and_then(|token| shared.agent_for(token));
    let Some(agent) = agent else {
        unauthorized(stream);
        return;
    };
    if request.path != "/mcp" {
        http::refuse(stream, 404, "Not Found", &[]);
        return;
    }
    // Not from a web page, and by this server's own name.
    if request.header("Origin").is_some() || !is_own_host(request.header("Host"), port) {
        http::refuse(stream, 403, "Forbidden", &[]);
        return;
    }
    if request.method != "POST" {
        http::refuse(stream, 405, "Method Not Allowed", &[("Allow", "POST")]);
        return;
    }
    request.body = match http::read_body(&mut reader, &request) {
        Ok(body) => body,
        Err(Refusal::Gone) => return,
        Err(Refusal::Status(status, reason)) => {
            http::refuse(stream, status, reason, &[]);
            return;
        }
    };
    shared.note_use(&agent.id);
    let message: Value = match serde_json::from_slice(&request.body) {
        Ok(message) => message,
        Err(_) => {
            json_reply(stream, &error(&Value::Null, -32700, "Not JSON"));
            return;
        }
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        json_reply(
            stream,
            &error(&Value::Null, -32600, "Not a JSON-RPC request"),
        );
        return;
    };
    // A notification, or a reply to the server: nothing to answer.
    let Some(id) = message.get("id").cloned() else {
        http::respond(stream, 202, "Accepted", &[], None, b"");
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = VERSIONS
                .iter()
                .find(|version| Some(**version) == asked)
                .unwrap_or(&VERSIONS[0]);
            json_reply(
                stream,
                &result(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "magnetcut", "version": shared.version },
                        "instructions": INSTRUCTIONS,
                    }),
                ),
            );
        }
        "ping" => json_reply(stream, &result(&id, json!({}))),
        "tools/list" => match shared.tools(TOOLS_TIMEOUT) {
            Some(tools) => json_reply(stream, &result(&id, json!({ "tools": tools }))),
            None => json_reply(stream, &error(&id, -32603, "The editor isn't ready")),
        },
        "tools/call" => {
            let streams = request
                .header("Accept")
                .is_some_and(|accept| accept.contains("text/event-stream"));
            call(shared, stream, &id, &params, &agent, streams);
        }
        _ => json_reply(stream, &error(&id, -32601, "No such method")),
    }
}

/// A tool call, handed to the editor; its progress sent on as it comes, if
/// the client takes events, and its result.
fn call(
    shared: &Shared,
    stream: &TcpStream,
    id: &Value,
    params: &Value,
    agent: &Caller,
    streams: bool,
) {
    let Some(tool) = params.get("name").and_then(Value::as_str) else {
        json_reply(
            stream,
            &error(id, -32602, "A tool call needs the tool's name"),
        );
        return;
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let progress_token = params
        .get("_meta")
        .and_then(|meta| meta.get("progressToken"))
        .cloned();
    let (number, updates) = match shared.start_call(agent, tool, arguments, TOOLS_TIMEOUT) {
        Ok(started) => started,
        Err(message) => {
            json_reply(stream, &result(id, failed(&message)));
            return;
        }
    };
    let streaming = streams && http::start_events(stream).is_ok();
    let answer = loop {
        match updates.recv_timeout(CALL_TIMEOUT) {
            Ok(super::Update::Progress {
                progress,
                total,
                message,
            }) => {
                if let (true, Some(token)) = (streaming, &progress_token) {
                    let note = json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": { "progressToken": token, "progress": progress, "total": total, "message": message },
                    });
                    // The client gone: the call still finishes in the editor.
                    let _ = http::event(stream, &note);
                }
            }
            Ok(super::Update::Done(answer)) => break answer,
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                shared.cancel(number);
                break failed("The editor didn't answer in time");
            }
        }
    };
    let reply = result(id, answer);
    if streaming {
        let _ = http::event(stream, &reply);
    } else {
        json_reply(stream, &reply);
    }
}

/// A tool's failure, as MCP has it: a result the agent reads, not an error.
pub fn failed(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

#[cfg(test)]
mod tests {
    use super::{bearer, is_own_host};

    #[test]
    fn knows_its_own_name() {
        assert!(is_own_host(Some("127.0.0.1:4000"), 4000));
        assert!(!is_own_host(Some("127.0.0.1:4001"), 4000));
        assert!(!is_own_host(Some("localhost:4000"), 4000));
        assert!(!is_own_host(Some("evil.example:4000"), 4000));
        assert!(!is_own_host(None, 4000));
    }

    #[test]
    fn takes_the_bearer_scheme_in_any_case() {
        assert_eq!(bearer("Bearer mc_a"), Some("mc_a"));
        assert_eq!(bearer("bearer  mc_a "), Some("mc_a"));
        assert_eq!(bearer("BEARER mc_a"), Some("mc_a"));
        assert_eq!(bearer("Basic mc_a"), None);
        assert_eq!(bearer("Bearer"), None);
        assert_eq!(bearer("mc_a"), None);
    }
}
