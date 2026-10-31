// HTTP/1.1, as much as MCP's Streamable HTTP needs from a server on
// 127.0.0.1: a request read whole (its headers, then the body its
// Content-Length says), and a reply, either whole or as server-sent events.
// Each connection answers one request and closes.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

// The most a request's line and headers may take, and its body.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;

// How long a client may take to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Request {
    pub method: String,
    pub path: String,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    /// A header's value, by its name in any case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Why a request couldn't be read: the status to answer with, if any.
#[derive(Debug)]
pub enum Refusal {
    /// Closed, or too slow: nothing to answer.
    Gone,
    /// Malformed or too big: 400 or 413.
    Status(u16, &'static str),
}

/// Reads one request from `stream`.
pub fn read_request(stream: &TcpStream) -> Result<Request, Refusal> {
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|_| Refusal::Gone)?;
    let mut reader = BufReader::new(stream);
    let mut head = 0usize;
    let mut line = String::new();
    let mut read_line = |line: &mut String| -> Result<(), Refusal> {
        line.clear();
        let count = (&mut reader)
            .take((MAX_HEAD - head + 1) as u64)
            .read_line(line)
            .map_err(|_| Refusal::Gone)?;
        if count == 0 {
            return Err(Refusal::Gone);
        }
        head += count;
        if head > MAX_HEAD {
            return Err(Refusal::Status(431, "Request Header Fields Too Large"));
        }
        Ok(())
    };
    read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(path), Some(_version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(Refusal::Status(400, "Bad Request"));
    };
    let (method, path) = (method.to_owned(), path.to_owned());
    let mut headers = Vec::new();
    loop {
        read_line(&mut line)?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            return Err(Refusal::Status(400, "Bad Request"));
        };
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
    let request = Request {
        method,
        path,
        headers,
        body: Vec::new(),
    };
    if request
        .header("Transfer-Encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(Refusal::Status(411, "Length Required"));
    }
    let length = match request.header("Content-Length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| Refusal::Status(400, "Bad Request"))?,
        None => 0,
    };
    if length > MAX_BODY {
        return Err(Refusal::Status(413, "Content Too Large"));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|_| Refusal::Gone)?;
    Ok(Request { body, ..request })
}

/// A whole reply: its status, then `body` as `kind` (or none).
pub fn respond(
    mut stream: &TcpStream,
    status: u16,
    reason: &str,
    extra: &[(&str, &str)],
    kind: Option<&str>,
    body: &[u8],
) {
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        body.len()
    );
    if let Some(kind) = kind {
        head.push_str(&format!("Content-Type: {kind}\r\n"));
    }
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// A reply of server-sent events: its head, after which each `event` is sent
/// as it comes, until the connection closes.
pub fn start_events(mut stream: &TcpStream) -> std::io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    )?;
    stream.flush()
}

/// One server-sent event: a JSON message.
pub fn event(mut stream: &TcpStream, message: &serde_json::Value) -> std::io::Result<()> {
    stream.write_all(format!("event: message\ndata: {message}\n\n").as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::{Refusal, read_request};
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};

    /// What `read_request` makes of `raw`, sent by a client.
    fn read(raw: &[u8]) -> Result<super::Request, Refusal> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.write_all(raw).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let (server, _) = listener.accept().unwrap();
        read_request(&server)
    }

    #[test]
    fn reads_the_head_and_the_body_it_says() {
        let request = read(
            b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:9\r\ncontent-length: 5\r\nAuthorization: Bearer x\r\n\r\nhello",
        )
        .unwrap();
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/mcp")
        );
        assert_eq!(request.header("Content-Length"), Some("5"));
        assert_eq!(request.header("authorization"), Some("Bearer x"));
        assert_eq!(request.body, b"hello");
    }

    #[test]
    fn refuses_what_it_wont_read() {
        assert!(matches!(
            read(b"POST /mcp HTTP/1.1\r\nContent-Length: 99999999999\r\n\r\n"),
            Err(Refusal::Status(413, _))
        ));
        assert!(matches!(
            read(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"),
            Err(Refusal::Status(411, _))
        ));
        let mut huge = b"GET / HTTP/1.1\r\n".to_vec();
        huge.extend(std::iter::repeat_n(b'x', 20_000));
        assert!(matches!(read(&huge), Err(Refusal::Status(431, _))));
        assert!(matches!(
            read(b"nonsense\r\n\r\n"),
            Err(Refusal::Status(400, _))
        ));
    }
}
