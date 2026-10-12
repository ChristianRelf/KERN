//! Provider adapters and the HTTP transport.
//!
//! Each provider has its own request format, response parser and error
//! classifier (no shared "one size fits all" request); `Provider` is the
//! common interface the router uses. The transport is a trait so routing
//! and failover can be tested deterministically against mocked responses.

use super::vault::{redact, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

// ------------------------------------------------------------ transport

pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// Lower-cased header names.
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransportError {
    /// Failed before the request could be sent (DNS, connect, TLS): the
    /// provider never saw it, so it is safe to try again elsewhere.
    NotSent(String),
    /// Timed out or broke after sending: the provider may have processed
    /// (and billed) it, so it must not be replayed automatically.
    Ambiguous(String),
}

pub trait Transport: Send + Sync {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError>;
}

pub struct UreqTransport;

impl Transport for UreqTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(req.timeout))
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent("Kern")
            .build();
        let agent: ureq::Agent = config.into();
        let result = match (req.method, &req.body) {
            ("POST", Some(body)) => {
                let mut b = agent.post(&req.url);
                for (k, v) in &req.headers {
                    b = b.header(k, v);
                }
                b.send(body.as_str())
            }
            _ => {
                let mut b = agent.get(&req.url);
                for (k, v) in &req.headers {
                    b = b.header(k, v);
                }
                b.call()
            }
        };
        let mut resp = result.map_err(|e| match e {
            ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Tls(_) | ureq::Error::BadUri(_) => {
                TransportError::NotSent(e.to_string())
            }
            ureq::Error::Timeout(t) => match t {
                ureq::Timeout::Resolve | ureq::Timeout::Connect => TransportError::NotSent(format!("timed out connecting ({t})")),
                _ => TransportError::Ambiguous(format!("timed out ({t})")),
            },
            other => TransportError::Ambiguous(other.to_string()),
        })?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_ascii_lowercase(), v.to_string())))
            .collect();
        let body = resp
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| TransportError::Ambiguous(format!("couldn't read the response ({e})")))?;
        Ok(HttpResponse { status, headers, body })
    }
}

// ------------------------------------------------------------ classification

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    /// Temporary request/token rate limit; retry after the given delay.
    RateLimited,
    /// Organisation or workspace spend limit reached.
    SpendLimit,
    /// Out of credits / billing problem.
    InsufficientQuota,
    InvalidKey,
    Permission,
    ModelUnavailable,
    /// Couldn't reach the provider.
    Network,
    /// Provider overloaded or erroring (5xx).
    Overloaded,
    /// Timed out after sending; outcome unknown.
    Timeout,
    InvalidRequest,
    Unknown,
}

impl ErrorCategory {
    pub fn label(self) -> &'static str {
        match self {
            ErrorCategory::RateLimited => "Rate limited",
            ErrorCategory::SpendLimit => "Spend limit reached",
            ErrorCategory::InsufficientQuota => "Out of credit",
            ErrorCategory::InvalidKey => "Invalid API key",
            ErrorCategory::Permission => "Missing permission",
            ErrorCategory::ModelUnavailable => "Model unavailable",
            ErrorCategory::Network => "Network unavailable",
            ErrorCategory::Overloaded => "Provider overloaded",
            ErrorCategory::Timeout => "Timed out",
            ErrorCategory::InvalidRequest => "Invalid request",
            ErrorCategory::Unknown => "Provider error",
        }
    }

    /// Failures that apply to the whole quota pool (organisation/project),
    /// so other keys in the same pool would fail the same way.
    pub fn pool_wide(self) -> bool {
        matches!(self, ErrorCategory::RateLimited | ErrorCategory::SpendLimit | ErrorCategory::InsufficientQuota)
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
    pub category: ErrorCategory,
    pub http_status: Option<u16>,
    /// Provider's own error type/code, for diagnostics.
    pub code: Option<String>,
    pub message: String,
    /// Seconds to wait, from `retry-after` (or a provider reset header).
    pub retry_after: Option<f64>,
    /// The provider never produced output for this attempt, so replaying it
    /// elsewhere can't duplicate work or charges.
    pub replay_safe: bool,
}

/// Rate-limit headers exactly as the provider reported them.
pub fn rate_limit_headers(h: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    h.iter()
        .filter(|(k, _)| k.starts_with("anthropic-ratelimit-") || k.starts_with("x-ratelimit-") || *k == "retry-after")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Parses durations like "20", "1.5", "6m0s", "1s", "250ms".
pub fn parse_seconds(v: &str) -> Option<f64> {
    let v = v.trim();
    if let Ok(n) = v.parse::<f64>() {
        return Some(n);
    }
    let mut total = 0.0;
    let mut num = String::new();
    let chars: Vec<char> = v.chars().collect();
    let mut i = 0;
    let mut any = false;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            i += 1;
            continue;
        }
        let n: f64 = num.parse().ok()?;
        num.clear();
        if c == 'm' && chars.get(i + 1) == Some(&'s') {
            total += n / 1000.0;
            i += 2;
        } else {
            total += match c {
                'h' => n * 3600.0,
                'm' => n * 60.0,
                's' => n,
                _ => return None,
            };
            i += 1;
        }
        any = true;
    }
    if !num.is_empty() {
        return None;
    }
    any.then_some(total)
}

// ------------------------------------------------------------ providers

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
}

impl Provider {
    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "anthropic" => Some(Provider::Anthropic),
            "openai" => Some(Provider::Openai),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Openai => "OpenAI",
        }
    }
}

/// Non-secret account details needed to address the provider.
#[derive(Debug, Clone, Default)]
pub struct Endpoint {
    pub base_url: Option<String>,
    pub organization_id: Option<String>,
    pub project_ref: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TextRequest {
    pub system: Option<String>,
    pub prompt: String,
    pub max_tokens: u32,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Completion {
    pub text: String,
    pub model: String,
    pub usage: Usage,
    pub stop_reason: Option<String>,
}

const ANTHROPIC_URL: &str = "https://api.anthropic.com";
const OPENAI_URL: &str = "https://api.openai.com";

fn base(p: Provider, e: &Endpoint) -> String {
    e.base_url.clone().unwrap_or_else(|| (if p == Provider::Anthropic { ANTHROPIC_URL } else { OPENAI_URL }).to_string())
}

fn auth_headers(p: Provider, key: &Secret, e: &Endpoint) -> Vec<(String, String)> {
    match p {
        Provider::Anthropic => vec![
            ("x-api-key".into(), key.expose().to_string()),
            ("anthropic-version".into(), "2023-06-01".into()),
        ],
        Provider::Openai => {
            let mut h = vec![("authorization".into(), format!("Bearer {}", key.expose()))];
            if let Some(o) = e.organization_id.as_ref().filter(|s| !s.is_empty()) {
                h.push(("openai-organization".into(), o.clone()));
            }
            if let Some(pr) = e.project_ref.as_ref().filter(|s| !s.is_empty()) {
                h.push(("openai-project".into(), pr.clone()));
            }
            h
        }
    }
}

impl Provider {
    /// A no-cost authenticated call (list models) used to validate keys.
    pub fn models_request(self, key: &Secret, e: &Endpoint) -> HttpRequest {
        let url = match self {
            Provider::Anthropic => format!("{}/v1/models?limit=100", base(self, e)),
            Provider::Openai => format!("{}/v1/models", base(self, e)),
        };
        HttpRequest { method: "GET", url, headers: auth_headers(self, key, e), body: None, timeout: Duration::from_secs(15) }
    }

    pub fn parse_models(self, body: &str) -> Vec<String> {
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let mut ids: Vec<String> = v
            .get("data")
            .and_then(|d| d.as_array())
            .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
            .unwrap_or_default();
        if self == Provider::Openai {
            // Only chat-capable families are useful for text requests.
            ids.retain(|id| id.starts_with("gpt-") || id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4") || id.starts_with("chatgpt"));
            ids.sort();
        }
        ids
    }

    pub fn complete_request(self, key: &Secret, e: &Endpoint, model: &str, req: &TextRequest) -> HttpRequest {
        let (url, body) = match self {
            Provider::Anthropic => {
                let mut b = json!({
                    "model": model,
                    "max_tokens": req.max_tokens,
                    "messages": [{ "role": "user", "content": req.prompt }],
                });
                if let Some(s) = &req.system {
                    b["system"] = json!(s);
                }
                (format!("{}/v1/messages", base(self, e)), b)
            }
            Provider::Openai => {
                let mut messages = vec![];
                if let Some(s) = &req.system {
                    messages.push(json!({ "role": "system", "content": s }));
                }
                messages.push(json!({ "role": "user", "content": req.prompt }));
                (
                    format!("{}/v1/chat/completions", base(self, e)),
                    json!({ "model": model, "max_completion_tokens": req.max_tokens, "messages": messages }),
                )
            }
        };
        let mut headers = auth_headers(self, key, e);
        headers.push(("content-type".into(), "application/json".into()));
        HttpRequest { method: "POST", url, headers, body: Some(body.to_string()), timeout: Duration::from_secs(120) }
    }

    pub fn parse_completion(self, body: &str) -> Option<Completion> {
        let v: Value = serde_json::from_str(body).ok()?;
        match self {
            Provider::Anthropic => {
                let text = v
                    .get("content")?
                    .as_array()?
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                let u = v.get("usage");
                let n = |k: &str| u.and_then(|u| u.get(k)).and_then(|x| x.as_i64());
                Some(Completion {
                    text,
                    model: v.get("model").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
                    usage: Usage {
                        input_tokens: n("input_tokens").map(|i| i + n("cache_creation_input_tokens").unwrap_or(0)),
                        output_tokens: n("output_tokens"),
                        cached_tokens: n("cache_read_input_tokens"),
                    },
                    stop_reason: v.get("stop_reason").and_then(|s| s.as_str()).map(String::from),
                })
            }
            Provider::Openai => {
                let choice = v.get("choices")?.as_array()?.first()?;
                let u = v.get("usage");
                let n = |k: &str| u.and_then(|u| u.get(k)).and_then(|x| x.as_i64());
                Some(Completion {
                    text: choice.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or_default().to_string(),
                    model: v.get("model").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
                    usage: Usage {
                        input_tokens: n("prompt_tokens"),
                        output_tokens: n("completion_tokens"),
                        cached_tokens: u.and_then(|u| u.pointer("/prompt_tokens_details/cached_tokens")).and_then(|x| x.as_i64()),
                    },
                    stop_reason: choice.get("finish_reason").and_then(|s| s.as_str()).map(String::from),
                })
            }
        }
    }

    /// The organisation a response says the key belongs to — keys sharing
    /// it share rate limits and billing.
    pub fn observed_pool(self, h: &BTreeMap<String, String>) -> Option<String> {
        match self {
            Provider::Anthropic => h.get("anthropic-organization-id").cloned(),
            Provider::Openai => h.get("openai-organization").cloned().map(|o| match h.get("openai-project") {
                Some(p) => format!("{o}/{p}"),
                None => o,
            }),
        }
    }

    /// Classifies a non-success response from structured fields: HTTP
    /// status, the provider's error `type`/`code` and headers. Message text
    /// is only a last-resort hint.
    pub fn classify(self, resp: &HttpResponse, key: Option<&Secret>) -> ProviderFailure {
        let v: Value = serde_json::from_str(&resp.body).unwrap_or(Value::Null);
        let err = v.get("error");
        let etype = err.and_then(|e| e.get("type")).and_then(|t| t.as_str()).map(String::from);
        let ecode = err.and_then(|e| e.get("code")).and_then(|t| t.as_str()).map(String::from);
        let raw_msg = err.and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("").to_string();
        let message = redact(&raw_msg, key).chars().take(500).collect::<String>();
        let lower = raw_msg.to_ascii_lowercase();
        let mut retry_after = resp.headers.get("retry-after").and_then(|v| parse_seconds(v));
        let status = resp.status;
        let category = match self {
            Provider::Anthropic => match (status, etype.as_deref()) {
                (_, Some("authentication_error")) | (401, _) => ErrorCategory::InvalidKey,
                (_, Some("billing_error")) | (402, _) => ErrorCategory::InsufficientQuota,
                (_, Some("permission_error")) | (403, _) => ErrorCategory::Permission,
                (_, Some("rate_limit_error")) | (429, _) => ErrorCategory::RateLimited,
                (_, Some("overloaded_error")) | (529, _) => ErrorCategory::Overloaded,
                (_, Some("not_found_error")) if lower.starts_with("model:") => ErrorCategory::ModelUnavailable,
                (_, Some("invalid_request_error")) if lower.contains("credit balance") => ErrorCategory::InsufficientQuota,
                (_, Some("invalid_request_error")) | (_, Some("request_too_large")) | (400 | 413, _) => ErrorCategory::InvalidRequest,
                (_, Some("api_error")) | (500..=599, _) => ErrorCategory::Overloaded,
                (404, _) => ErrorCategory::InvalidRequest,
                _ => ErrorCategory::Unknown,
            },
            Provider::Openai => match (status, ecode.as_deref(), etype.as_deref()) {
                (_, Some("insufficient_quota"), _) | (_, _, Some("insufficient_quota")) => ErrorCategory::InsufficientQuota,
                (_, Some("billing_hard_limit_reached"), _) | (_, Some("billing_not_active"), _) => ErrorCategory::SpendLimit,
                (_, Some("invalid_api_key"), _) | (401, _, _) => ErrorCategory::InvalidKey,
                (_, Some("model_not_found"), _) => ErrorCategory::ModelUnavailable,
                (403, _, _) => ErrorCategory::Permission,
                (_, Some("rate_limit_exceeded"), _) | (429, _, _) => ErrorCategory::RateLimited,
                (400 | 404 | 413 | 422, _, _) => ErrorCategory::InvalidRequest,
                (500..=599, _, _) => ErrorCategory::Overloaded,
                _ => ErrorCategory::Unknown,
            },
        };
        if category == ErrorCategory::RateLimited && retry_after.is_none() {
            // OpenAI reports when its window resets instead of retry-after.
            retry_after = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
                .iter()
                .filter_map(|k| resp.headers.get(*k).and_then(|v| parse_seconds(v)))
                .fold(None, |acc: Option<f64>, x| Some(acc.map_or(x, |a| a.max(x))));
        }
        ProviderFailure {
            category,
            http_status: Some(status),
            code: ecode.or(etype),
            message: if message.is_empty() { format!("HTTP {status}") } else { message },
            retry_after,
            replay_safe: true,
        }
    }
}

pub fn transport_failure(e: &TransportError) -> ProviderFailure {
    match e {
        TransportError::NotSent(m) => ProviderFailure {
            category: ErrorCategory::Network,
            http_status: None,
            code: None,
            message: format!("Couldn't reach the provider ({m})."),
            retry_after: None,
            replay_safe: true,
        },
        TransportError::Ambiguous(m) => ProviderFailure {
            category: ErrorCategory::Timeout,
            http_status: None,
            code: None,
            message: format!("The request didn't complete ({m}). It may still have been processed, so it wasn't retried."),
            retry_after: None,
            replay_safe: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(status: u16, body: &str, headers: &[(&str, &str)]) -> HttpResponse {
        HttpResponse { status, body: body.into(), headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn classifies_anthropic_errors_structurally() {
        let a = Provider::Anthropic;
        let r = resp(429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#, &[("retry-after", "12")]);
        let f = a.classify(&r, None);
        assert_eq!((f.category, f.retry_after), (ErrorCategory::RateLimited, Some(12.0)));
        assert_eq!(a.classify(&resp(402, r#"{"type":"error","error":{"type":"billing_error","message":"x"}}"#, &[]), None).category, ErrorCategory::InsufficientQuota);
        assert_eq!(a.classify(&resp(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, &[]), None).category, ErrorCategory::InvalidKey);
        assert_eq!(a.classify(&resp(529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, &[]), None).category, ErrorCategory::Overloaded);
        assert_eq!(a.classify(&resp(404, r#"{"type":"error","error":{"type":"not_found_error","message":"model: nope"}}"#, &[]), None).category, ErrorCategory::ModelUnavailable);
        assert_eq!(a.classify(&resp(400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#, &[]), None).category, ErrorCategory::InvalidRequest);
        // Unparseable body still classified from the status.
        assert_eq!(a.classify(&resp(503, "<html>", &[]), None).category, ErrorCategory::Overloaded);
    }

    #[test]
    fn classifies_openai_errors_by_code() {
        let o = Provider::Openai;
        let quota = resp(429, r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}"#, &[]);
        assert_eq!(o.classify(&quota, None).category, ErrorCategory::InsufficientQuota, "a 429 isn't always a rate limit");
        let rl = resp(429, r#"{"error":{"message":"Rate limit","type":"requests","code":"rate_limit_exceeded"}}"#, &[("x-ratelimit-reset-requests", "6m0s")]);
        let f = o.classify(&rl, None);
        assert_eq!((f.category, f.retry_after), (ErrorCategory::RateLimited, Some(360.0)));
        let key = Secret::new("sk-proj-abcdefghijklmnopqrstuvwxyz".into());
        let bad = resp(401, r#"{"error":{"message":"Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz.","code":"invalid_api_key"}}"#, &[]);
        let f = o.classify(&bad, Some(&key));
        assert_eq!(f.category, ErrorCategory::InvalidKey);
        assert!(!f.message.contains("abcdefghij"), "key must be redacted from messages");
    }

    #[test]
    fn parses_usage() {
        let c = Provider::Anthropic
            .parse_completion(r#"{"model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}"#)
            .unwrap();
        assert_eq!((c.text.as_str(), c.usage.input_tokens, c.usage.output_tokens, c.usage.cached_tokens), ("hi", Some(12), Some(3), Some(4)));
        let c = Provider::Openai
            .parse_completion(r#"{"model":"gpt-x","choices":[{"message":{"content":"yo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}"#)
            .unwrap();
        assert_eq!((c.text.as_str(), c.usage.cached_tokens), ("yo", Some(1)));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_seconds("6m0s"), Some(360.0));
        assert_eq!(parse_seconds("250ms"), Some(0.25));
        assert_eq!(parse_seconds("1.5"), Some(1.5));
        assert_eq!(parse_seconds("soon"), None);
    }

    #[test]
    fn keys_go_in_headers_never_urls() {
        let key = Secret::new("sk-ant-abcdefghijklmnop1234".into());
        for p in [Provider::Anthropic, Provider::Openai] {
            let r = p.models_request(&key, &Endpoint::default());
            assert!(!r.url.contains("abcdefghij"));
            let r = p.complete_request(&key, &Endpoint::default(), "m", &TextRequest { system: None, prompt: "x".into(), max_tokens: 5 });
            assert!(!r.url.contains("abcdefghij") && !r.body.unwrap().contains("abcdefghij"));
        }
    }
}
