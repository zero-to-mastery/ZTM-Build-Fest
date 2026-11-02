//! A minimal HTTP/1.1 layer over `std::net`: enough to parse one request per
//! connection and write one response, with hard limits on everything an
//! untrusted client controls (line length, header count, body size, time).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

const MAX_LINE: u64 = 8 * 1024;
const MAX_HEADERS: usize = 100;
/// Total time a client gets to deliver the request line and headers. Without
/// this, a client trickling one byte per few seconds would hold a connection
/// slot indefinitely, since each read restarts the socket timeout.
const HEAD_DEADLINE: Duration = Duration::from_secs(15);
/// Total time a client gets to deliver one request, body included.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
/// Longest a single write may block on a client that stopped reading.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    /// The path without the query string, percent-decoded.
    pub path: String,
    pub query: HashMap<String, String>,
    /// Header names are lower-cased.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    /// The client's IP address (no port).
    pub peer: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.header("cookie")?.split(';').find_map(|part| {
            let (k, v) = part.trim().split_once('=')?;
            (k == name).then_some(v)
        })
    }

    pub fn is_read_only(&self) -> bool {
        self.method == "GET" || self.method == "HEAD"
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), content_type.into())],
            body,
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self::new(
            status,
            "text/plain; charset=utf-8",
            body.as_bytes().to_vec(),
        )
    }

    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Self::new(
            status,
            "application/json; charset=utf-8",
            value.to_string().into_bytes(),
        )
    }

    pub fn error(status: u16, message: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": message }))
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
}

/// A request that could not be read; carries the status to answer with.
#[derive(Debug)]
pub struct ReadError {
    pub status: u16,
    pub message: &'static str,
}

fn err(status: u16, message: &'static str) -> ReadError {
    ReadError { status, message }
}

/// One client connection. Reading is split in two so the server can decide,
/// from the headers alone, whether a body is welcome (and how large) before
/// it buffers any of it. That keeps unauthenticated clients from making the
/// process hold megabytes of upload.
pub struct Conn<'a> {
    reader: BufReader<&'a TcpStream>,
    started: Instant,
    /// Declared body length of the request returned by `read_head`.
    pub body_length: usize,
}

impl<'a> Conn<'a> {
    pub fn new(stream: &'a TcpStream) -> Self {
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok();
        Self {
            reader: BufReader::new(stream),
            started: Instant::now(),
            body_length: 0,
        }
    }

    /// Read the request line and headers. The returned request has an empty body.
    pub fn read_head(&mut self) -> Result<Request, ReadError> {
        let peer = self
            .reader
            .get_ref()
            .peer_addr()
            .map(|a| a.ip().to_string())
            .unwrap_or_default();
        let request_line =
            read_line(&mut self.reader, self.started)?.ok_or_else(|| err(400, "empty request"))?;
        let mut parts = request_line.split_whitespace();
        let method = parts
            .next()
            .ok_or_else(|| err(400, "bad request line"))?
            .to_string();
        let target = parts
            .next()
            .ok_or_else(|| err(400, "bad request line"))?
            .to_string();
        let version = parts.next().unwrap_or("");
        if !version.starts_with("HTTP/1.") {
            return Err(err(505, "unsupported HTTP version"));
        }
        if parts.next().is_some() || !target.starts_with('/') {
            return Err(err(400, "bad request target"));
        }

        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let line = read_line(&mut self.reader, self.started)?
                .ok_or_else(|| err(400, "truncated headers"))?;
            if line.is_empty() {
                break;
            }
            if headers.len() >= MAX_HEADERS {
                return Err(err(431, "too many headers"));
            }
            let (name, value) = line.split_once(':').ok_or_else(|| err(400, "bad header"))?;
            let name = name.trim().to_ascii_lowercase();
            if name.is_empty() || name.contains(' ') {
                return Err(err(400, "bad header name"));
            }
            // A repeated Content-Length is a request-smuggling vector; refuse it.
            if headers.contains_key(&name)
                && matches!(
                    name.as_str(),
                    "content-length" | "host" | "transfer-encoding"
                )
            {
                return Err(err(400, "duplicate header"));
            }
            headers.insert(name, value.trim().to_string());
        }
        if headers.contains_key("transfer-encoding") {
            return Err(err(501, "chunked bodies are not supported"));
        }
        self.body_length = match headers.get("content-length") {
            Some(v) => v.parse().map_err(|_| err(400, "bad Content-Length"))?,
            None => 0,
        };

        let (raw_path, raw_query) = match target.split_once('?') {
            Some((p, q)) => (p, q.split('#').next().unwrap_or("")),
            None => (target.split('#').next().unwrap_or(&target), ""),
        };
        let path = percent_decode(raw_path);
        if path.contains('\0') {
            return Err(err(400, "bad path"));
        }
        let query = raw_query
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                (
                    percent_decode(&k.replace('+', " ")),
                    percent_decode(&v.replace('+', " ")),
                )
            })
            .collect();
        Ok(Request {
            method,
            path,
            query,
            headers,
            body: Vec::new(),
            peer,
        })
    }

    /// Read the declared body into `request`, refusing anything over `max`.
    pub fn read_body(&mut self, request: &mut Request, max: usize) -> Result<(), ReadError> {
        let length = self.body_length;
        if length > max {
            return Err(err(413, "request body too large"));
        }
        let mut body = Vec::with_capacity(length.min(1 << 20));
        let mut chunk = [0u8; 16 * 1024];
        while body.len() < length {
            if self.started.elapsed() > REQUEST_DEADLINE {
                return Err(err(408, "request took too long"));
            }
            let want = (length - body.len()).min(chunk.len());
            match self.reader.read(&mut chunk[..want]) {
                Ok(0) => return Err(err(400, "body ended early")),
                Ok(n) => body.extend_from_slice(&chunk[..n]),
                Err(_) => return Err(err(408, "timed out reading the body")),
            }
        }
        request.body = body;
        Ok(())
    }
}

fn read_line<R: BufRead>(reader: &mut R, started: Instant) -> Result<Option<String>, ReadError> {
    if started.elapsed() > HEAD_DEADLINE {
        return Err(err(408, "request headers took too long"));
    }
    let mut buf = Vec::new();
    let n = reader
        .by_ref()
        .take(MAX_LINE + 1)
        .read_until(b'\n', &mut buf)
        .map_err(|_| err(408, "timed out reading the request"))?;
    if n == 0 {
        return Ok(None);
    }
    if n as u64 > MAX_LINE {
        return Err(err(431, "header line too long"));
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| err(400, "non-UTF-8 header"))
}

pub fn write_response(
    mut stream: &TcpStream,
    response: &Response,
    head_only: bool,
) -> std::io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        303 => "See Other",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        505 => "HTTP Version Not Supported",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, reason);
    let mut has_length = false;
    for (name, value) in &response.headers {
        // Header values come from our own code, but never let a stray newline split a response.
        let clean: String = value.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        if name.eq_ignore_ascii_case("content-length") {
            has_length = true;
        }
        head.push_str(&format!("{name}: {clean}\r\n"));
    }
    if !has_length {
        head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    head.push_str("X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if !head_only {
        stream.write_all(&response.body)?;
    }
    stream.flush()
}

pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    fn roundtrip(raw: &'static [u8], max_body: usize) -> Result<Request, ReadError> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut s = TcpStream::connect(addr).unwrap();
            s.write_all(raw).unwrap();
            s.flush().unwrap();
            s
        });
        let (server_side, _) = listener.accept().unwrap();
        let mut conn = Conn::new(&server_side);
        let result = conn
            .read_head()
            .and_then(|mut req| conn.read_body(&mut req, max_body).map(|_| req));
        drop(client.join().unwrap());
        result
    }

    #[test]
    fn parses_a_post_with_query_cookies_and_body() {
        let req = roundtrip(
            b"POST /admin/api/x?name=a%20b&k=v+w HTTP/1.1\r\nHost: localhost\r\nCookie: a=1; ob_session=tok\r\nContent-Length: 5\r\n\r\nhello",
            100,
        )
        .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/admin/api/x");
        assert_eq!(req.query["name"], "a b");
        assert_eq!(req.query["k"], "v w");
        assert_eq!(req.cookie("ob_session"), Some("tok"));
        assert_eq!(req.body, b"hello");
        assert_eq!(req.peer, "127.0.0.1");
    }

    #[test]
    fn rejects_oversized_chunked_duplicate_and_malformed_requests() {
        assert_eq!(
            roundtrip(b"POST / HTTP/1.1\r\nContent-Length: 500\r\n\r\n", 100)
                .unwrap_err()
                .status,
            413
        );
        assert_eq!(
            roundtrip(
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
                100
            )
            .unwrap_err()
            .status,
            501
        );
        assert_eq!(
            roundtrip(
                b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx",
                100
            )
            .unwrap_err()
            .status,
            400
        );
        assert_eq!(
            roundtrip(b"GET / HTTP/2.0\r\n\r\n", 100)
                .unwrap_err()
                .status,
            505
        );
        assert_eq!(
            roundtrip(b"GET nope HTTP/1.1\r\n\r\n", 100)
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            roundtrip(b"GET / HTTP/1.1\r\nBroken\r\n\r\n", 100)
                .unwrap_err()
                .status,
            400
        );
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/100%"), "/100%");
        assert_eq!(percent_decode("/%zz"), "/%zz");
        assert_eq!(percent_decode("%2e%2e"), "..");
    }
}
