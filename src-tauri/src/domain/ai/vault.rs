//! Secret storage for AI API keys.
//!
//! Keys live only in the operating system's credential store (Windows
//! Credential Manager, macOS Keychain, Linux Secret Service). SQLite holds a
//! reference name, never the key. Secrets are read on demand inside the
//! backend for the duration of one request and are never returned to the
//! frontend, logged or put in URLs.

use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// An API key in memory. Debug/Display never reveal it and the buffer is
/// overwritten when dropped.
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(s)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    /// Last four characters, for telling keys apart in the UI.
    pub fn hint(&self) -> String {
        let chars: Vec<char> = self.0.chars().collect();
        if chars.len() < 12 {
            return String::new();
        }
        chars[chars.len() - 4..].iter().collect()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: zero bytes are valid UTF-8; the string is dropped right after.
        unsafe { self.0.as_mut_vec().fill(0) };
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(••••)")
    }
}

pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &str, secret: &Secret) -> AppResult<()>;
    fn get(&self, reference: &str) -> AppResult<Option<Secret>>;
    fn delete(&self, reference: &str) -> AppResult<()>;
}

/// The OS credential store, via the `keyring` crate.
pub struct OsKeyring {
    service: String,
}

impl OsKeyring {
    pub fn new(service: impl Into<String>) -> Self {
        OsKeyring { service: service.into() }
    }

    fn entry(&self, reference: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, reference).map_err(|e| AppError::Other(format!("The system credential store isn't available ({}).", describe(&e))))
    }
}

/// Keyring errors never include secrets, but keep messages generic anyway.
fn describe(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::NoStorageAccess(_) => "access was denied",
        keyring::Error::PlatformFailure(_) => "platform error",
        keyring::Error::BadEncoding(_) => "unreadable entry",
        keyring::Error::TooLong(_, _) => "value too long",
        keyring::Error::Invalid(_, _) => "invalid entry",
        keyring::Error::Ambiguous(_) => "duplicate entries",
        keyring::Error::NoEntry => "no entry",
        _ => "unknown error",
    }
}

impl SecretStore for OsKeyring {
    fn set(&self, reference: &str, secret: &Secret) -> AppResult<()> {
        self.entry(reference)?
            .set_password(secret.expose())
            .map_err(|e| AppError::Other(format!("Couldn't save the key to the system credential store ({}).", describe(&e))))
    }
    fn get(&self, reference: &str) -> AppResult<Option<Secret>> {
        match self.entry(reference)?.get_password() {
            Ok(s) => Ok(Some(Secret::new(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Other(format!("Couldn't read the key from the system credential store ({}).", describe(&e)))),
        }
    }
    fn delete(&self, reference: &str) -> AppResult<()> {
        match self.entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Other(format!("Couldn't remove the key from the system credential store ({}).", describe(&e)))),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn set(&self, reference: &str, secret: &Secret) -> AppResult<()> {
        self.0.lock().unwrap().insert(reference.into(), secret.expose().into());
        Ok(())
    }
    fn get(&self, reference: &str) -> AppResult<Option<Secret>> {
        Ok(self.0.lock().unwrap().get(reference).map(|s| Secret::new(s.clone())))
    }
    fn delete(&self, reference: &str) -> AppResult<()> {
        self.0.lock().unwrap().remove(reference);
        Ok(())
    }
}

impl MemoryStore {
    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

/// Removes anything that looks like an API key from text that may be shown
/// or stored (provider error messages occasionally echo request details).
pub fn redact(text: &str, secret: Option<&Secret>) -> String {
    let mut out = text.to_string();
    if let Some(s) = secret {
        if !s.expose().is_empty() {
            out = out.replace(s.expose(), "[redacted]");
        }
    }
    // Generic key shapes: sk-..., sk-ant-..., sk-proj-...
    let mut result = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 's' && bytes.get(i + 1) == Some(&'k') && bytes.get(i + 2) == Some(&'-') {
            let mut j = i + 3;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == '-' || bytes[j] == '_') {
                j += 1;
            }
            if j - i >= 16 {
                result.push_str("[redacted]");
                i = j;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_print() {
        let s = Secret::new("sk-ant-api03-supersecretvalue1234".into());
        assert_eq!(format!("{s:?}"), "Secret(••••)");
        assert_eq!(s.hint(), "1234");
    }

    #[test]
    fn redaction_removes_keys() {
        let s = Secret::new("sk-proj-abcdefghijklmnop".into());
        assert_eq!(redact("bad key sk-proj-abcdefghijklmnop here", Some(&s)), "bad key [redacted] here");
        assert_eq!(redact("Incorrect API key provided: sk-abc123XYZabc123XYZ.", None), "Incorrect API key provided: [redacted].");
        assert_eq!(redact("ask-me sk-short", None), "ask-me sk-short");
    }
}
