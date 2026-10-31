// The agent server end to end: a real server on a free port, an editor that
// answers calls, and requests as an MCP client sends them.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::thread;

use serde_json::{Value, json};

use super::{Agents, ToolCall, Update, lock};

/// Agent mode on, with one agent: the agents, its token, the server's port,
/// and the calls the editor gets.
fn serving() -> (Agents, String, u16, mpsc::Receiver<ToolCall>) {
    let folder = std::env::temp_dir().join(format!(
        "agents-test-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    let (calls, received) = mpsc::channel();
    let agents = Agents::new(
        super::tokens::location(folder),
        "9.9.9".into(),
        Box::new(move |call| calls.send(call.clone()).map_err(|error| error.to_string())),
    );
    let token = {
        let mut store = lock(&agents.0.store);
        store.enabled = true;
        store.add("Test agent").unwrap().1
    };
    let port = agents.0.start().unwrap();
    (agents, token, port, received)
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
    assert_eq!(
        send(
            port,
            &format!("POST /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")
        )
        .0,
        404
    );
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
    let (agents, token, port, calls) = serving();
    let shared = std::sync::Arc::clone(&agents.0);
    // The editor: progress, then the answer.
    let editor = thread::spawn(move || {
        let call = calls.recv().unwrap();
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
