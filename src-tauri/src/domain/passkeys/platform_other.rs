// @Author Christian Relf
// @Date 2026-10-15

//! Platforms without an authenticator binding yet. macOS would go through
//! `ASAuthorizationPlatformPublicKeyCredentialProvider` (Touch ID) and Linux
//! through CTAP2 over USB HID; both would implement exactly the three
//! functions below, and nothing above this module would change.

use super::{Assertion, Kind, Registered, Support};
use crate::error::{AppError, AppResult};

const REASON: &str = "Passkeys use the operating system's own authenticator, which Kern only speaks to on Windows (Windows Hello or a security key) so far.";

pub fn support() -> Support {
    Support { platform: false, security_key: false, reason: Some(REASON.into()) }
}

pub fn register(_hwnd: isize, _label: &str, _challenge: &[u8], _user_handle: &[u8], _kind: Kind) -> AppResult<Registered> {
    Err(AppError::Invalid(REASON.into()))
}

pub fn assert(_hwnd: isize, _challenge: &[u8], _allow: &[Vec<u8>]) -> AppResult<Assertion> {
    Err(AppError::Locked(REASON.into()))
}
