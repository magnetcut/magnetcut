// The agent server end to end: a real server on a free port, an editor that
// answers calls, and requests as an MCP client sends them.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use super::{Agents, Caller, ToEditor, ToolCall, Update, lock};

/// What the editor gets: calls, and calls to drop.
struct Editor {
    calls: mpsc::Receiver<ToolCall>,
    cancelled: mpsc::Receiver<Vec<u64>>,
}

/// Agent mode on, with one agent, on `port` if it's free: the agents and
/// what the editor gets.
fn agents_on(port: u16) -> (Agents, Editor) {
    let folder = std::env::temp_dir().join(format!(
        "agents-test-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    let (calls, received) = mpsc::channel();
    let (cancels, cancelled) = mpsc::channel();
    let agents = Agents::new(
        super::tokens::location(folder),
        "9.9.9".into(),
        Box::new(move |message| match message {
            ToEditor::Call(call) => calls.send(call.clone()).map_err(|error| error.to_string()),
            ToEditor::Cancel(numbers) => cancels
                .send(numbers.to_vec())
                .map_err(|error| error.to_string()),
        }),
    );
    {
        let mut store = lock(&agents.0.store);
        store.enabled = true;
        store.port = port;
    }
    (
        agents,
        Editor {
            calls: received,
            cancelled,
        },
    )
}

/// Agent mode on, with one agent, and the editor listening: the agents, its
/// token, the server's port, and what the editor gets.
fn serving() -> (Agents, String, u16, Editor) {
    // A port of the test's own: the default may be the app's.
    let (agents, editor) = agents_on(free_port());
    let token = lock(&agents.0.store).add("Test agent", None).unwrap().1;
    let port = agents.0.start().unwrap();
    *lock(&agents.0.tools) = Some(json!([]));
    agents.0.tools_ready.notify_all();
    (agents, token, port, editor)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// The agent a token is for.
fn caller(agents: &Agents, token: &str) -> Caller {
    agents.0.agent_for(token).unwrap()
}

fn rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos()
        .into()
}

/// A raw request: the status, and the body.
fn send(port: u16, request: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    let status = reply
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse().ok())
        .unwrap_or(0);
    let body = reply
        .split_once("\r\n\r\n")
        .map_or("", |(_, body)| body)
        .to_owned();
    (status, body)
}

/// A JSON-RPC request as an MCP client posts it.
fn post(port: u16, token: Option<&str>, extra: &str, message: &Value) -> (u16, String) {
    let body = message.to_string();
    let authorization = token.map_or(String::new(), |token| {
        format!("Authorization: Bearer {token}\r\n")
    });
    send(
        port,
        &format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{authorization}{extra}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    )
}

fn initialize() -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } })
}

#[test]
fn lets_in_only_an_agent_with_its_token_by_the_servers_own_name() {
    let (agents, token, port, _) = serving();
    assert_eq!(post(port, None, "", &initialize()).0, 401);
    assert_eq!(post(port, Some("mc_wrong"), "", &initialize()).0, 401);
    // From a web page, or by another name: refused even with the token.
    assert_eq!(
        post(
            port,
            Some(&token),
            "Origin: https://evil.example\r\n",
            &initialize()
        )
        .0,
        403
    );
    let other_host = format!(
        "POST /mcp HTTP/1.1\r\nHost: evil.example:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
    );
    assert_eq!(send(port, &other_host).0, 403);
    assert_eq!(
        send(port, &format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n")).0,
        405
    );
    // By another name for this computer, too.
    let localhost = format!(
        "POST /mcp HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
    );
    assert_eq!(send(port, &localhost).0, 403);
    assert_eq!(
        send(
            port,
            &format!("POST /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n")
        )
        .0,
        404
    );
    // Without the token, 401 and nothing else, whatever else is wrong; the
    // body isn't read.
    for request in [
        format!("POST /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        "GET /mcp HTTP/1.1\r\nHost: evil.example\r\nOrigin: https://evil.example\r\n\r\n"
            .to_owned(),
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 99999999999\r\n\r\n"
        ),
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nTransfer-Encoding: chunked\r\n\r\n"
        ),
        format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 10\r\n\r\n"),
        "nonsense\r\n\r\n".to_owned(),
        format!("GET /{} HTTP/1.1\r\n\r\n", "x".repeat(20_000)),
    ] {
        assert_eq!(send(port, &request).0, 401, "{request:.80}");
    }
    // The scheme in any case.
    let lower = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: bearer {token}\r\nContent-Length: 2\r\n\r\n{{}}"
    );
    assert_eq!(send(port, &lower).0, 200);
    let (status, body) = post(port, Some(&token), "", &initialize());
    assert_eq!(status, 200, "{body}");
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(reply["result"]["serverInfo"]["version"], "9.9.9");
    // Revoked, it's out.
    let id = lock(&agents.0.store).agents[0].id.clone();
    lock(&agents.0.store).revoke(&id);
    assert_eq!(post(port, Some(&token), "", &initialize()).0, 401);
}

#[test]
fn takes_notifications_and_lists_the_editors_tools() {
    let (agents, token, port, _) = serving();
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert_eq!(post(port, Some(&token), "", &note).0, 202);
    *lock(&agents.0.tools) =
        Some(json!([{ "name": "summary", "inputSchema": { "type": "object" } }]));
    agents.0.tools_ready.notify_all();
    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
    let (status, body) = post(port, Some(&token), "", &list);
    assert_eq!(status, 200);
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(reply["result"]["tools"][0]["name"], "summary");
    let unknown = json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" });
    let reply: Value = serde_json::from_str(&post(port, Some(&token), "", &unknown).1).unwrap();
    assert_eq!(reply["error"]["code"], -32601);
}

#[test]
fn hands_a_call_to_the_editor_and_streams_its_progress_back() {
    let (agents, token, port, editor) = serving();
    let shared = std::sync::Arc::clone(&agents.0);
    // The editor: progress, then the answer.
    let editor = thread::spawn(move || {
        let call = editor.calls.recv().unwrap();
        assert_eq!(call.tool, "export");
        assert_eq!(call.agent, "Test agent");
        assert!(shared.named(call.call, "/tmp/film.mp4"));
        assert!(!shared.named(call.call, "/etc/passwd"));
        shared.update(
            call.call,
            Update::Progress {
                progress: 0.5,
                total: Some(1.0),
                message: Some("half".into()),
            },
        );
        shared.update(
            call.call,
            Update::Done(json!({ "content": [{ "type": "text", "text": "done" }] })),
        );
    });
    let call = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
        "name": "export", "arguments": { "path": "/tmp/film.mp4" }, "_meta": { "progressToken": "p1" } } });
    let (status, body) = post(port, Some(&token), "", &call);
    editor.join().unwrap();
    assert_eq!(status, 200);
    let events: Vec<Value> = body
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str(data).unwrap())
        .collect();
    assert_eq!(events.len(), 2, "{body}");
    assert_eq!(events[0]["method"], "notifications/progress");
    assert_eq!(events[0]["params"]["progressToken"], "p1");
    assert_eq!(events[0]["params"]["message"], "half");
    assert_eq!(events[1]["id"], 4);
    assert_eq!(events[1]["result"]["content"][0]["text"], "done");
    // The call's over: its paths no longer open anything.
    assert!(!agents.0.named(1, "/tmp/film.mp4"));
}

#[test]
fn stops_serving_when_switched_off() {
    let (agents, token, port, _) = serving();
    agents.0.stop();
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_err()
            || post(port, Some(&token), "", &initialize()).0 == 0
    );
}

#[test]
fn a_project_files_media_open_with_it() {
    let (agents, token, _, editor) = serving();
    let (number, _updates) = agents
        .0
        .start_call(
            &caller(&agents, &token),
            "project",
            json!({ "path": "/films/trip.magnetcut" }),
            Duration::ZERO,
        )
        .unwrap();
    editor.calls.recv().unwrap();
    assert!(!agents.0.named(number, "/films/beach.mp4"));
    let text = r#"{ "magnetcut": 1, "project": {}, "media": [{ "id": "m1", "path": "/films/beach.mp4" }] }"#;
    agents.0.allow(number, super::media_paths(text));
    assert!(agents.0.named(number, "/films/beach.mp4"));
    assert!(!agents.0.named(number, "/films/other.mp4"));
}

#[test]
fn the_command_lines_relay_takes_the_reply_and_its_progress() {
    let (agents, token, port, editor) = serving();
    let shared = std::sync::Arc::clone(&agents.0);
    let editor = thread::spawn(move || {
        let call = editor.calls.recv().unwrap();
        shared.update(
            call.call,
            Update::Progress {
                progress: 1.0,
                total: Some(2.0),
                message: None,
            },
        );
        shared.update(
            call.call,
            Update::Done(json!({ "content": [{ "type": "text", "text": "summary" }] })),
        );
    });
    let address = format!("127.0.0.1:{port}");
    let server = super::cli::Server::new(&address, "/mcp", &token);
    let mut messages = Vec::new();
    server
        .post(
            &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
                "name": "summary", "_meta": { "progressToken": 1 } } })
            .to_string(),
            |message| messages.push(message),
        )
        .unwrap();
    editor.join().unwrap();
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert_eq!(messages[0]["method"], "notifications/progress");
    assert_eq!(messages[1]["result"]["content"][0]["text"], "summary");
    let wrong = super::cli::Server::new(&address, "/mcp", "mc_wrong");
    let refused = wrong.post(
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(),
        |_| {},
    );
    assert!(refused.unwrap_err().contains("token"));
}

/// A tool call made over HTTP on its own thread: the reply's text, once it
/// comes.
fn call_in_background(port: u16, token: &str, path: &str) -> thread::JoinHandle<Value> {
    let token = token.to_owned();
    let call = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {
        "name": "export", "arguments": { "path": path } } });
    thread::spawn(move || {
        let (status, body) = post(port, Some(&token), "", &call);
        assert_eq!(status, 200, "{body}");
        let data = body
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .next_back()
            .unwrap_or(&body)
            .to_owned();
        serde_json::from_str(&data).unwrap()
    })
}

#[test]
fn revoking_an_agent_ends_its_calls_and_closes_their_paths() {
    let (agents, token, port, editor) = serving();
    let reply = call_in_background(port, &token, "/tmp/film.mp4");
    let call = editor.calls.recv().unwrap();
    assert!(agents.0.named(call.call, "/tmp/film.mp4"));
    let id = lock(&agents.0.store).agents[0].id.clone();
    agents.0.revoke(&id).unwrap();
    // The agent's told at once, rather than in 30 minutes; the editor drops
    // the call; and what it named no longer opens.
    let reply = reply.join().unwrap();
    assert_eq!(reply["result"]["isError"], true);
    assert!(
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("revoked"),
        "{reply}"
    );
    assert_eq!(editor.cancelled.recv().unwrap(), vec![call.call]);
    assert!(!agents.0.named(call.call, "/tmp/film.mp4"));
    assert!(!agents.0.is_live(call.call));
    // Its answer, coming late, goes nowhere.
    agents.0.update(call.call, Update::Done(json!({})));
}

#[test]
fn switching_off_ends_the_calls_on_their_way() {
    let (agents, token, port, editor) = serving();
    let reply = call_in_background(port, &token, "/tmp/film.mp4");
    let call = editor.calls.recv().unwrap();
    agents.0.set_enabled(false).unwrap();
    let reply = reply.join().unwrap();
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(editor.cancelled.recv().unwrap(), vec![call.call]);
    assert!(!agents.0.named(call.call, "/tmp/film.mp4"));
    // A request let in just before is refused.
    let refused = agents.0.start_call(
        &caller(&agents, &token),
        "summary",
        json!({}),
        Duration::ZERO,
    );
    assert!(refused.is_err());
    assert!(editor.calls.try_recv().is_err());
}

#[test]
fn a_call_waits_for_the_editor_to_listen_and_ends_if_its_page_goes() {
    let (agents, token, port, editor) = serving();
    // As the app starts, or its page reloads: no tools yet.
    agents.editor_gone();
    let reply = call_in_background(port, &token, "/tmp/film.mp4");
    // Not sent where no one listens.
    assert!(
        editor
            .calls
            .recv_timeout(Duration::from_millis(300))
            .is_err()
    );
    *lock(&agents.0.tools) = Some(json!([]));
    agents.0.tools_ready.notify_all();
    let call = editor.calls.recv().unwrap();
    // The page reloads before it answers: the agent's told, not left waiting.
    agents.editor_gone();
    let reply = reply.join().unwrap();
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(editor.cancelled.recv().unwrap(), vec![call.call]);
    assert!(lock(&agents.0.tools).is_none());
    // And with no page, a call is refused once it has waited.
    let refused = agents.0.start_call(
        &caller(&agents, &token),
        "summary",
        json!({}),
        Duration::from_millis(50),
    );
    assert!(refused.unwrap_err().contains("isn't ready"));
}

#[test]
fn a_call_that_timed_out_is_dropped_by_the_editor() {
    let (agents, token, _, editor) = serving();
    let (number, _updates) = agents
        .0
        .start_call(
            &caller(&agents, &token),
            "edit",
            json!({ "operations": [] }),
            Duration::ZERO,
        )
        .unwrap();
    editor.calls.recv().unwrap();
    agents.0.cancel(number);
    assert_eq!(editor.cancelled.recv().unwrap(), vec![number]);
    assert!(!agents.0.is_live(number));
}

#[test]
fn a_port_taken_is_stood_in_for_but_not_kept() {
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let kept = taken.local_addr().unwrap().port();
    let (agents, _) = agents_on(kept);
    let port = agents.0.start().unwrap();
    assert_ne!(port, kept);
    assert_eq!(lock(&agents.0.store).port, kept);
    assert_eq!(super::tokens::Store::load(&agents.0.store_path).port, 0);
}
