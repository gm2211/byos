//! A deliberately small TLS boundary. No HTTP, credentials, networking, custom trust roots,
//! certificate bypass, key export, session persistence, or application logging lives here.
use std::io::{Cursor, Read, Write};
use std::sync::Arc;
use std::time::Duration;
use rustls::pki_types::{ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use wasm_bindgen::prelude::*;

#[derive(Debug)]
struct BrowserClock;
impl rustls::time_provider::TimeProvider for BrowserClock {
    fn current_time(&self) -> Option<UnixTime> {
        #[cfg(target_arch = "wasm32")]
        let seconds = js_sys::Date::now() / 1000.0;
        #[cfg(not(target_arch = "wasm32"))]
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64();
        if !seconds.is_finite() || seconds <= 0.0 { return None; }
        Some(UnixTime::since_unix_epoch(Duration::from_secs(seconds as u64)))
    }
}

fn configuration() -> Arc<ClientConfig> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = ClientConfig::builder_with_details(
        Arc::new(rustls::crypto::ring::default_provider()), Arc::new(BrowserClock),
    ).with_protocol_versions(&[&rustls::version::TLS13])
        .expect("TLS 1.3 supported by pinned provider")
        .with_root_certificates(roots).with_no_client_auth();
    config.enable_early_data = false;
    config.resumption = rustls::client::Resumption::disabled();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

fn permitted_host(host: &str) -> bool { matches!(host, "auth.openai.com" | "chatgpt.com") }
fn supported_alpn(protocol: Option<&[u8]>) -> bool { protocol == Some(b"http/1.1".as_slice()) }
fn failure() -> JsValue { JsValue::from_str("OpenAI TLS verification or transport failed.") }

#[wasm_bindgen]
pub struct BrowserTls {
    connection: ClientConnection,
    failed: bool,
    peer_closed: bool,
}

#[wasm_bindgen]
impl BrowserTls {
    #[wasm_bindgen(constructor)]
    pub fn new(host: &str) -> Result<BrowserTls, JsValue> {
        if !permitted_host(host) { return Err(failure()); }
        let name = ServerName::try_from(host.to_owned()).map_err(|_| failure())?;
        let mut connection = ClientConnection::new(configuration(), name).map_err(|_| failure())?;
        connection.set_buffer_limit(Some(128 * 1024));
        Ok(Self { connection, failed: false, peer_closed: false })
    }

    /// True only after peer authentication and the required HTTP/1.1 ALPN negotiation.
    pub fn ready(&self) -> bool {
        !self.failed && !self.connection.is_handshaking()
            && supported_alpn(self.connection.alpn_protocol())
    }
    pub fn closed(&self) -> bool { self.peer_closed }

    /// Consume part of a TLS input frame. The caller must retain the unread suffix and
    /// drain plaintext between calls: rustls bounds both its TLS and plaintext buffers.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<usize, JsValue> {
        if self.failed || bytes.len() > 128 * 1024 { return Err(failure()); }
        let consumed = match self.connection.read_tls(&mut Cursor::new(bytes)) {
            Ok(n) if n > 0 => n,
            _ => { self.failed = true; return Err(failure()); }
        };
        match self.connection.process_new_packets() {
            Ok(state) => {
                self.peer_closed = state.peer_has_closed();
                if !self.connection.is_handshaking()
                    && !supported_alpn(self.connection.alpn_protocol())
                {
                    self.failed = true;
                    return Err(failure());
                }
            }
            Err(error) => {
                self.failed = true;
                // Fixed categories support negative tests without certificate/server payload dumps.
                let code = match error {
                    rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => "UnknownIssuer",
                    rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName) |
                    rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForNameContext { .. }) => "NotValidForName",
                    rustls::Error::InvalidCertificate(rustls::CertificateError::Expired) |
                    rustls::Error::InvalidCertificate(rustls::CertificateError::ExpiredContext { .. }) => "ExpiredCertificate",
                    _ => "TlsVerificationFailed",
                };
                return Err(JsValue::from_str(code));
            }
        }
        Ok(consumed)
    }

    /// There is no way to submit application plaintext before peer authentication succeeds.
    pub fn write(&mut self, plaintext: &[u8]) -> Result<usize, JsValue> {
        if !self.ready() || self.peer_closed || plaintext.len() > 64 * 1024 { return Err(failure()); }
        self.connection.writer().write(plaintext).map_err(|_| failure())
    }

    pub fn outgoing(&mut self) -> Result<Vec<u8>, JsValue> {
        if self.failed { return Err(failure()); }
        let mut output = Vec::new();
        while self.connection.wants_write() {
            self.connection.write_tls(&mut output).map_err(|_| failure())?;
        }
        Ok(output)
    }

    pub fn plaintext(&mut self) -> Result<Vec<u8>, JsValue> {
        if self.failed { return Err(failure()); }
        let mut output = vec![0u8; 64 * 1024];
        match self.connection.reader().read(&mut output) {
            Ok(n) => { output.truncate(n); Ok(output) },
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(Vec::new()),
            Err(_) => { self.failed = true; Err(failure()) },
        }
    }

    pub fn close(&mut self) { self.connection.send_close_notify(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_provider_hosts_are_allowed() {
        for host in ["auth.openai.com", "chatgpt.com"] { assert!(permitted_host(host)); }
        for host in ["localhost", "127.0.0.1", "chatgpt.com.", "CHATGPT.COM", "evil.chatgpt.com"] {
            assert!(!permitted_host(host));
        }
    }
    #[test]
    fn only_negotiated_http_11_is_supported() {
        assert!(supported_alpn(Some(b"http/1.1")));
        assert!(!supported_alpn(None));
        assert!(!supported_alpn(Some(b"h2")));
        assert!(!supported_alpn(Some(b"http/1.1\0")));
    }
    #[test]
    fn config_has_no_early_data_resumption_or_client_certificate() {
        let cfg = configuration();
        assert!(!cfg.enable_early_data);
        assert_eq!(cfg.alpn_protocols, [b"http/1.1".to_vec()]);
        let name = ServerName::try_from("chatgpt.com").unwrap();
        let c = ClientConnection::new(cfg, name).unwrap();
        assert!(c.is_handshaking());
        assert!(c.wants_write());
    }
}
