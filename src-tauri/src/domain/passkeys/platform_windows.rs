// @Author Christian Relf
// @Date 2026-10-15

//! Passkeys through `webauthn.dll` - the OS API that drives both Windows
//! Hello (face, fingerprint, PIN) and security keys over USB, and that draws
//! the prompt itself. Both calls block while that prompt is up, so they run
//! on a worker thread with the database lock released.

use super::{Assertion, Kind, Registered, Support};
use crate::error::{AppError, AppResult};
use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::Networking::WindowsWebServices::*;

/// Relying-party id. Nothing is ever sent anywhere - Kern is its own relying
/// party - but the OS files credentials under this id, so it is the author's
/// own domain rather than one belonging to somebody else.
const RP_ID: &str = "kern.chrisrelf.xyz";
const RP_NAME: &str = "Kern";
/// How long the OS prompt waits before giving up.
const TIMEOUT_MS: u32 = 60_000;

/// Version 1 of both options structs carries everything used here, so an
/// older `webauthn.dll` (Windows 10 1903) is still happy.
const MAKE_VERSION: u32 = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_1;
const ASSERT_VERSION: u32 = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_1;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `webauthn.dll` reports failures as WebAuthn DOM error names; turn the ones
/// a person can act on into plain sentences.
fn describe(e: windows::core::Error) -> String {
    let name = unsafe { WebAuthNGetErrorName(e.code()) };
    let name = if name.is_null() { String::new() } else { unsafe { name.to_string() }.unwrap_or_default() };
    match name.as_str() {
        "NotAllowedError" => "The passkey prompt was dismissed, or it timed out.".into(),
        "InvalidStateError" => "That authenticator already holds a Kern passkey. Use it to unlock, or remove the old one first.".into(),
        "NotSupportedError" => "That authenticator can't hold a Kern passkey.".into(),
        "ConstraintError" => "That authenticator can't verify who you are, which a Kern passkey needs.".into(),
        "UnknownError" | "" => format!("Windows couldn't complete the request ({:#010x}).", e.code().0 as u32),
        other => format!("Windows reported {other}."),
    }
}

fn attachment(kind: Kind) -> u32 {
    match kind {
        Kind::Platform => WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,
        Kind::SecurityKey => WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM,
    }
}

/// The client data a browser would send. Kern verifies nothing against it,
/// but the authenticator signs over it, so the challenge belongs in it.
fn client_data(kind: &str, challenge: &[u8]) -> Vec<u8> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    format!(
        "{{\"type\":\"{kind}\",\"challenge\":\"{}\",\"origin\":\"https://{RP_ID}\",\"crossOrigin\":false}}",
        URL_SAFE_NO_PAD.encode(challenge)
    )
    .into_bytes()
}

pub fn support() -> Support {
    // Any Windows with the DLL can talk to a security key; Hello is only
    // there if the machine has a verifying platform authenticator set up.
    let version = unsafe { WebAuthNGetApiVersionNumber() };
    if version == 0 {
        return Support { platform: false, security_key: false, reason: Some("This copy of Windows has no WebAuthn support, so passkeys can't be used.".into()) };
    }
    let platform = unsafe { WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable() }.map(|b| b.as_bool()).unwrap_or(false);
    Support {
        platform,
        security_key: true,
        reason: (!platform).then(|| "Windows Hello isn't set up on this computer, so only a security key can be used.".to_string()),
    }
}

pub fn register(hwnd: isize, label: &str, challenge: &[u8], user_handle: &[u8], kind: Kind) -> AppResult<Registered> {
    let (rp_id, rp_name) = (wide(RP_ID), wide(RP_NAME));
    // Shown in the OS prompt and in Windows' own passkey list.
    let (user_name, user_display) = (wide(label), wide(label));
    let mut handle = user_handle.to_vec();
    let mut data = client_data("webauthn.create", challenge);

    let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
        pwszId: PCWSTR(rp_id.as_ptr()),
        pwszName: PCWSTR(rp_name.as_ptr()),
        pwszIcon: PCWSTR::null(),
    };
    let user = WEBAUTHN_USER_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
        cbId: handle.len() as u32,
        pbId: handle.as_mut_ptr(),
        pwszName: PCWSTR(user_name.as_ptr()),
        pwszIcon: PCWSTR::null(),
        pwszDisplayName: PCWSTR(user_display.as_ptr()),
    };
    let cd = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: data.len() as u32,
        pbClientDataJSON: data.as_mut_ptr(),
        pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    };
    let param = |alg| WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
        dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
        pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
        lAlg: alg,
    };
    let mut algs = [param(WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256), param(WEBAUTHN_COSE_ALGORITHM_RSASSA_PKCS1_V1_5_WITH_SHA256)];
    let cose = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS { cCredentialParameters: algs.len() as u32, pCredentialParameters: algs.as_mut_ptr() };

    let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
        dwVersion: MAKE_VERSION,
        dwTimeoutMilliseconds: TIMEOUT_MS,
        dwAuthenticatorAttachment: attachment(kind),
        // Non-discoverable: Kern keeps the credential ids itself and passes
        // them as an allow-list, so nothing clutters the OS passkey picker.
        bRequireResidentKey: false.into(),
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        // No attestation: Kern doesn't care which make of authenticator it is.
        dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
        ..Default::default()
    };

    let att = unsafe { WebAuthNAuthenticatorMakeCredential(HWND(hwnd as *mut _), &rp, &user, &cose, &cd, Some(&options)) }
        .map_err(|e| AppError::Invalid(describe(e)))?;
    if att.is_null() {
        return Err(AppError::Other("Windows returned no credential.".into()));
    }
    // Copy what's needed before handing the block back.
    let out = unsafe {
        let a = &*att;
        let id = std::slice::from_raw_parts(a.pbCredentialId, a.cbCredentialId as usize).to_vec();
        let verified = user_verified(std::slice::from_raw_parts(a.pbAuthenticatorData, a.cbAuthenticatorData as usize));
        WebAuthNFreeCredentialAttestation(Some(att));
        Registered { credential_id: id, kind, user_verified: verified }
    };
    if out.credential_id.is_empty() {
        return Err(AppError::Other("Windows returned an empty credential id.".into()));
    }
    Ok(out)
}

pub fn assert(hwnd: isize, challenge: &[u8], allow: &[Vec<u8>]) -> AppResult<Assertion> {
    if allow.is_empty() {
        return Err(AppError::Invalid("No passkey is registered on this computer.".into()));
    }
    let rp_id = wide(RP_ID);
    let mut data = client_data("webauthn.get", challenge);
    let type_name = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;

    // The allow-list has to outlive the call, hence the owned copies.
    let mut ids: Vec<Vec<u8>> = allow.to_vec();
    let mut creds: Vec<WEBAUTHN_CREDENTIAL> = ids
        .iter_mut()
        .map(|id| WEBAUTHN_CREDENTIAL {
            dwVersion: WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
            cbId: id.len() as u32,
            pbId: id.as_mut_ptr(),
            pwszCredentialType: type_name,
        })
        .collect();

    let cd = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: data.len() as u32,
        pbClientDataJSON: data.as_mut_ptr(),
        pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    };
    let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
        dwVersion: ASSERT_VERSION,
        dwTimeoutMilliseconds: TIMEOUT_MS,
        CredentialList: WEBAUTHN_CREDENTIALS { cCredentials: creds.len() as u32, pCredentials: creds.as_mut_ptr() },
        // Either kind of authenticator may answer; the allow-list decides.
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        ..Default::default()
    };

    let assertion = unsafe { WebAuthNAuthenticatorGetAssertion(HWND(hwnd as *mut _), PCWSTR(rp_id.as_ptr()), &cd, Some(&options)) }
        .map_err(|e| AppError::Locked(describe(e)))?;
    if assertion.is_null() {
        return Err(AppError::Other("Windows returned no assertion.".into()));
    }
    Ok(unsafe {
        let a = &*assertion;
        let used = std::slice::from_raw_parts(a.Credential.pbId, a.Credential.cbId as usize).to_vec();
        let verified = user_verified(std::slice::from_raw_parts(a.pbAuthenticatorData, a.cbAuthenticatorData as usize));
        WebAuthNFreeAssertion(assertion);
        Assertion { credential_id: used, user_verified: verified }
    })
}

/// The UV bit of the authenticator data flags: the authenticator says it
/// checked who was there (biometric or PIN), not merely that something was
/// plugged in. Layout: 32 bytes of RP id hash, then the flags byte.
fn user_verified(auth_data: &[u8]) -> bool {
    auth_data.get(32).is_some_and(|f| f & 0x04 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_user_verified_flag() {
        let mut data = vec![0u8; 37];
        assert!(!user_verified(&data));
        data[32] = 0x01; // user present only
        assert!(!user_verified(&data));
        data[32] = 0x05; // present + verified
        assert!(user_verified(&data));
        assert!(!user_verified(&[]), "truncated data is not a verification");
    }

    #[test]
    fn client_data_carries_the_challenge() {
        let json = String::from_utf8(client_data("webauthn.get", &[0xff, 0x00, 0xff])).unwrap();
        assert!(json.contains("\"type\":\"webauthn.get\""));
        assert!(json.contains("\"challenge\":\"_wD_\""));
        assert!(json.contains(RP_ID));
    }
}
