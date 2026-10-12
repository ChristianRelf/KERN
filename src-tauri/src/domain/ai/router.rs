//! Provider routing: which credential serves a request, and what happens
//! when it fails.
//!
//!   AI request → candidate selection (policy, project preferences, budgets,
//!   cooldowns) → secure vault → provider adapter → response → usage tracking
//!
//! Safeguards:
//! - Attempts are bounded (`ai.maxAttempts`), cancellable and never loop.
//! - Only failures that produced no output are replayed elsewhere; a request
//!   that timed out after sending may have been processed and is reported
//!   instead of resubmitted. Callers can also mark a request non-replayable.
//! - Rate limits honour the provider's retry delay. Pool-wide failures
//!   (rate limit, quota, spend limit) never fail over to a key known to share
//!   the same organisation/project, so adding keys can't be used to evade a
//!   provider limit.
//! - Billing failures put the account in a long cooldown: the same doomed
//!   request isn't sent again and again.
//! - Network failures and bad requests don't change account status and
//!   don't trigger failover. Cross-provider substitution needs explicit opt-in.

use super::accounts::{self, Account};
use super::provider::{rate_limit_headers, transport_failure, Completion, Endpoint, ErrorCategory, Provider, ProviderFailure, TextRequest, Transport};
use super::vault::SecretStore;
use crate::domain::settings;
use crate::error::{AppError, AppResult};
use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

/// Access to the database without holding it across network calls.
pub trait Db {
    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T>;
}

impl Db for crate::state::AppState {
    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        self.with(|c| f(c))
    }
}

pub struct AiService {
    pub vault: Box<dyn SecretStore>,
    pub transport: Box<dyn Transport>,
    cancelled: Mutex<HashSet<String>>,
    /// Test hook: replaces real sleeping.
    pub sleep: Box<dyn Fn(Duration) + Send + Sync>,
}

impl AiService {
    pub fn new(vault: Box<dyn SecretStore>, transport: Box<dyn Transport>) -> Self {
        AiService { vault, transport, cancelled: Mutex::new(HashSet::new()), sleep: Box::new(std::thread::sleep) }
    }
    pub fn cancel(&self, request_id: &str) {
        self.cancelled.lock().unwrap().insert(request_id.to_string());
    }
    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled.lock().unwrap().contains(request_id)
    }
    fn finish(&self, request_id: &str) {
        self.cancelled.lock().unwrap().remove(request_id);
    }
    /// Sleeps in short slices so cancellation is prompt. Returns false if cancelled.
    fn wait(&self, request_id: &str, secs: f64) -> bool {
        let mut left = Duration::from_secs_f64(secs.max(0.0));
        while !left.is_zero() {
            if self.is_cancelled(request_id) {
                return false;
            }
            let step = left.min(Duration::from_millis(250));
            (self.sleep)(step);
            left -= step;
        }
        !self.is_cancelled(request_id)
    }
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RouteRequest {
    pub request_id: String,
    pub prompt: String,
    pub system: Option<String>,
    pub max_tokens: Option<u32>,
    /// Use this account first (manual selection).
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub project_id: Option<String>,
    /// Set false for requests with side effects: they're never resubmitted.
    pub replayable: Option<bool>,
    pub purpose: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub account_id: String,
    pub account_name: String,
    pub model: String,
    pub ok: bool,
    pub category: Option<ErrorCategory>,
    pub message: Option<String>,
    pub duration_ms: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Switch {
    pub from: String,
    pub to: String,
    pub reason: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RouteOutcome {
    pub ok: bool,
    pub text: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    pub usage: Option<super::provider::Usage>,
    pub estimated_cost: Option<f64>,
    pub stop_reason: Option<String>,
    pub attempts: Vec<Attempt>,
    pub switches: Vec<Switch>,
    pub warnings: Vec<String>,
    pub error: Option<ProviderFailure>,
}

#[derive(Deserialize, Debug, Clone, Copy)]
struct Price {
    input: f64,
    output: f64,
    #[serde(default)]
    cached: Option<f64>,
}

struct Policy {
    mode: String,
    cross_provider: bool,
    max_attempts: usize,
    max_wait: f64,
    prices: HashMap<String, Price>,
}

fn policy(conn: &Connection) -> Policy {
    Policy {
        mode: settings::get_or(conn, "ai.routingMode", "failover".to_string()),
        cross_provider: settings::get_or(conn, "ai.crossProvider", false),
        max_attempts: settings::get_or::<i64>(conn, "ai.maxAttempts", 3).clamp(1, 6) as usize,
        max_wait: settings::get_or::<f64>(conn, "ai.maxRetryWaitSeconds", 20.0).clamp(0.0, 120.0),
        prices: settings::get_or(conn, "ai.modelPrices", HashMap::new()),
    }
}

fn estimate(prices: &HashMap<String, Price>, model: &str, u: &super::provider::Usage) -> Option<f64> {
    let p = prices.get(model)?;
    let input = u.input_tokens.unwrap_or(0) as f64;
    let cached = u.cached_tokens.unwrap_or(0) as f64;
    let output = u.output_tokens.unwrap_or(0) as f64;
    Some((input * p.input + cached * p.cached.unwrap_or(p.input) + output * p.output) / 1_000_000.0)
}

/// Default model when an account has none. Anthropic's current default is
/// documented; for OpenAI the user picks from the models the key can see.
fn default_model(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Anthropic => Some("claude-opus-5-5"),
        Provider::Openai => None,
    }
}

struct ProjectPrefs {
    account_id: Option<String>,
    model: Option<String>,
}

fn project_prefs(conn: &Connection, project_id: &str) -> ProjectPrefs {
    let raw: String = conn.query_row("SELECT ai_prefs FROM projects WHERE id = ?1", [project_id], |r| r.get(0)).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if v.get("inherit").and_then(|b| b.as_bool()).unwrap_or(true) {
        return ProjectPrefs { account_id: None, model: None };
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    ProjectPrefs { account_id: s("accountId"), model: s("model") }
}

/// Why an account can't be used right now, if it can't.
fn ineligible(a: &Account, now: i64, prices: &HashMap<String, Price>) -> Option<String> {
    if !a.enabled {
        return Some("disabled".into());
    }
    if a.status == "auth_error" {
        return Some("its key was rejected".into());
    }
    if a.cooling_down(now) {
        return Some(format!("{} until {}", a.status.replace('_', " "), chrono::DateTime::from_timestamp_millis(a.cooldown_until.unwrap()).map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default()));
    }
    if a.budget_hard {
        if let Some(limit) = a.budget_limit {
            let used = match a.budget_unit.as_deref() {
                Some("usd") => a.month.cost.unwrap_or(0.0),
                _ => a.month.tokens as f64,
            };
            if used >= limit {
                return Some("its Kern budget for this month is used up".into());
            }
        }
    }
    let _ = prices;
    None
}

/// Orders accounts for a request according to the routing policy.
fn candidates(accounts: &[Account], pol: &Policy, explicit: Option<&str>) -> Vec<Account> {
    let primary = accounts.iter().find(|a| a.role == "primary").map(|a| a.id.clone());
    let first = explicit.map(String::from).or(primary.clone());
    let by_priority: Vec<&Account> = accounts.iter().collect(); // already in priority order
    let mut out: Vec<Account> = vec![];
    let push = |out: &mut Vec<Account>, a: &Account| {
        if !out.iter().any(|x| x.id == a.id) {
            out.push(a.clone());
        }
    };
    match pol.mode.as_str() {
        "manual" => {
            if let Some(a) = first.as_ref().and_then(|id| accounts.iter().find(|a| &a.id == id)) {
                push(&mut out, a);
            }
        }
        "priority" => {
            if let Some(a) = explicit.and_then(|id| accounts.iter().find(|a| a.id == id)) {
                push(&mut out, a);
            }
            for a in &by_priority {
                if a.failover_eligible || out.is_empty() {
                    push(&mut out, a);
                }
            }
        }
        "cost" => {
            if let Some(a) = explicit.and_then(|id| accounts.iter().find(|a| a.id == id)) {
                push(&mut out, a);
            }
            let price = |a: &Account| {
                a.preferred_model
                    .as_deref()
                    .or(default_model(a.provider))
                    .and_then(|m| pol.prices.get(m))
                    .map(|p| p.input + p.output)
                    .unwrap_or(f64::INFINITY)
            };
            let mut sorted: Vec<&Account> = by_priority.iter().copied().filter(|a| a.failover_eligible).collect();
            sorted.sort_by(|a, b| price(a).partial_cmp(&price(b)).unwrap_or(std::cmp::Ordering::Equal));
            for a in sorted {
                push(&mut out, a);
            }
        }
        _ => {
            // Automatic failover: the chosen (or primary) account, then
            // designated fallbacks, then other eligible accounts by priority.
            if let Some(a) = first.as_ref().and_then(|id| accounts.iter().find(|a| &a.id == id)) {
                push(&mut out, a);
            }
            for a in by_priority.iter().filter(|a| a.role == "fallback" && a.failover_eligible) {
                push(&mut out, a);
            }
            for a in by_priority.iter().filter(|a| a.failover_eligible) {
                push(&mut out, a);
            }
            if out.is_empty() {
                if let Some(a) = accounts.first() {
                    push(&mut out, a);
                }
            }
        }
    }
    out
}

fn record_event(db: &impl Db, request_id: &str, a: &Account, model: &str, purpose: &str, attempt: usize, started: i64, completion: Option<&Completion>, failure: Option<&ProviderFailure>, cost: Option<f64>) {
    let _ = db.with_conn(|c| {
        let u = completion.map(|c| c.usage.clone()).unwrap_or_default();
        c.execute(
            "INSERT INTO ai_usage_events(request_id, account_id, provider, model, purpose, attempt, started_at, duration_ms,
               input_tokens, output_tokens, cached_tokens, success, error_category, http_status, estimated_cost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                request_id,
                a.id,
                a.provider.as_str(),
                model,
                purpose,
                attempt as i64,
                started,
                now_ms() - started,
                u.input_tokens,
                u.output_tokens,
                u.cached_tokens,
                completion.is_some() as i64,
                failure.map(|f| serde_json::to_value(f.category).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()),
                failure.and_then(|f| f.http_status),
                cost
            ],
        )?;
        Ok(())
    });
}

fn record_switch(db: &impl Db, request_id: &str, from: &Account, to: Option<&Account>, reason: ErrorCategory, detail: &str) {
    let _ = db.with_conn(|c| {
        c.execute(
            "INSERT INTO ai_failover_events(request_id, from_account_id, to_account_id, reason, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                request_id,
                from.id,
                to.map(|a| a.id.clone()),
                serde_json::to_value(reason).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
                detail,
                now_ms()
            ],
        )?;
        Ok(())
    });
}

fn fail(outcome: &mut RouteOutcome, f: ProviderFailure) -> RouteOutcome {
    outcome.ok = false;
    outcome.error = Some(f);
    outcome.clone()
}

fn simple_failure(category: ErrorCategory, message: impl Into<String>) -> ProviderFailure {
    ProviderFailure { category, http_status: None, code: None, message: message.into(), retry_after: None, replay_safe: true }
}

pub fn route(db: &impl Db, svc: &AiService, req: &RouteRequest) -> AppResult<RouteOutcome> {
    let result = route_inner(db, svc, req);
    svc.finish(&req.request_id);
    result
}

fn route_inner(db: &impl Db, svc: &AiService, req: &RouteRequest) -> AppResult<RouteOutcome> {
    let mut outcome = RouteOutcome {
        ok: false,
        text: None,
        account_id: None,
        account_name: None,
        provider: None,
        model: None,
        usage: None,
        estimated_cost: None,
        stop_reason: None,
        attempts: vec![],
        switches: vec![],
        warnings: vec![],
        error: None,
    };
    if req.prompt.trim().is_empty() {
        return Err(AppError::Invalid("Write a prompt first.".into()));
    }
    let (pol, network, accounts, prefs) = db.with_conn(|c| {
        Ok((
            policy(c),
            settings::get_or(c, "privacy.network", true),
            accounts::list(c)?,
            req.project_id.as_deref().map(|p| project_prefs(c, p)),
        ))
    })?;
    if !network {
        return Ok(fail(&mut outcome, simple_failure(ErrorCategory::Network, "External network requests are turned off in Privacy settings.")));
    }
    if accounts.is_empty() {
        return Ok(fail(&mut outcome, simple_failure(ErrorCategory::Unknown, "Add an API account first.")));
    }
    let explicit = req.account_id.clone().or_else(|| prefs.as_ref().and_then(|p| p.account_id.clone()));
    let requested_model = req.model.clone().or_else(|| prefs.as_ref().and_then(|p| p.model.clone()));
    let mut queue = candidates(&accounts, &pol, explicit.as_deref());
    // Without cross-provider substitution, stay with the first candidate's provider.
    let lead_provider = queue.first().map(|a| a.provider);
    if !pol.cross_provider {
        queue.retain(|a| Some(a.provider) == lead_provider);
    }
    let now = now_ms();
    let mut skipped: Vec<String> = vec![];
    queue.retain(|a| match ineligible(a, now, &pol.prices) {
        Some(why) => {
            skipped.push(format!("{} ({why})", a.name));
            false
        }
        None => true,
    });
    if queue.is_empty() {
        let msg = if skipped.is_empty() { "No account can serve this request.".to_string() } else { format!("No account is available: {}.", skipped.join("; ")) };
        return Ok(fail(&mut outcome, simple_failure(ErrorCategory::Unknown, msg)));
    }

    let replayable = req.replayable.unwrap_or(true);
    let purpose = req.purpose.clone().unwrap_or_else(|| "request".into());
    let text_req = TextRequest { system: req.system.clone(), prompt: req.prompt.clone(), max_tokens: req.max_tokens.unwrap_or(1024).clamp(1, 16000) };
    let mut failed_pools: HashSet<String> = HashSet::new();
    let mut attempts = 0usize;
    let mut idx = 0usize;
    let mut tries_on_current = 0usize;

    while idx < queue.len() {
        let a = queue[idx].clone();
        if attempts >= pol.max_attempts {
            return Ok(fail(&mut outcome, simple_failure(ErrorCategory::Unknown, format!("Stopped after {} attempts.", pol.max_attempts))));
        }
        if svc.is_cancelled(&req.request_id) {
            return Ok(fail(&mut outcome, simple_failure(ErrorCategory::Unknown, "Cancelled.")));
        }
        // A pool-wide failure elsewhere rules out keys known to share that pool.
        if let Some(pool) = a.pool() {
            if failed_pools.contains(&pool) && tries_on_current == 0 {
                outcome.warnings.push(format!("Skipped {}: it shares a usage pool with an account that just hit its limit.", a.name));
                idx += 1;
                continue;
            }
        }
        let model = match requested_model.clone().filter(|_| Some(a.provider) == lead_provider) {
            Some(m) => m,
            None => match a.preferred_model.clone().or(default_model(a.provider).map(String::from)) {
                Some(m) => m,
                None => {
                    outcome.warnings.push(format!("Skipped {}: choose a default model for it first.", a.name));
                    idx += 1;
                    continue;
                }
            },
        };
        let key = match svc.vault.get(&a.credential_ref())? {
            Some(k) => k,
            None => {
                let f = simple_failure(ErrorCategory::InvalidKey, "The key for this account isn't in this device's credential store. Enter it again.");
                db.with_conn(|c| accounts::record_failure(c, &a.id, ErrorCategory::InvalidKey, &f.message, None))?;
                outcome.attempts.push(Attempt { account_id: a.id.clone(), account_name: a.name.clone(), model: model.clone(), ok: false, category: Some(f.category), message: Some(f.message.clone()), duration_ms: 0 });
                if pol.mode == "manual" || idx + 1 >= queue.len() {
                    return Ok(fail(&mut outcome, f));
                }
                record_switch(db, &req.request_id, &a, queue.get(idx + 1), f.category, &f.message);
                outcome.switches.push(Switch { from: a.name.clone(), to: queue[idx + 1].name.clone(), reason: f.category.label().into() });
                idx += 1;
                continue;
            }
        };
        let endpoint = Endpoint { base_url: None, organization_id: a.organization_id.clone(), project_ref: a.project_ref.clone() };
        let http = a.provider.complete_request(&key, &endpoint, &model, &text_req);
        drop(key);
        attempts += 1;
        tries_on_current += 1;
        let started = now_ms();
        let sent = svc.transport.send(&http);
        drop(http);
        let failure = match sent {
            Ok(resp) if resp.status == 200 => match a.provider.parse_completion(&resp.body) {
                Some(done) => {
                    let limits = json!({ "headers": rate_limit_headers(&resp.headers), "observedAt": now_ms() });
                    let pool = a.provider.observed_pool(&resp.headers);
                    let cost = estimate(&pol.prices, &done.model, &done.usage).or_else(|| estimate(&pol.prices, &model, &done.usage));
                    record_event(db, &req.request_id, &a, &model, &purpose, attempts, started, Some(&done), None, cost);
                    db.with_conn(|c| accounts::record_success(c, &a.id, pool.as_deref(), Some(&limits), None, false))?;
                    outcome.attempts.push(Attempt { account_id: a.id.clone(), account_name: a.name.clone(), model: model.clone(), ok: true, category: None, message: None, duration_ms: now_ms() - started });
                    // Budget warning (Kern-tracked, not a provider limit).
                    if let (Some(limit), Ok(fresh)) = (a.budget_limit, db.with_conn(|c| accounts::get(c, &a.id))) {
                        let used = if a.budget_unit.as_deref() == Some("usd") { fresh.month.cost.unwrap_or(0.0) } else { fresh.month.tokens as f64 };
                        if used >= limit * a.budget_warn_percent as f64 / 100.0 {
                            outcome.warnings.push(format!("{} has used {:.0}% of its Kern budget this month.", a.name, used / limit * 100.0));
                        }
                    }
                    outcome.ok = true;
                    outcome.text = Some(done.text.clone());
                    outcome.account_id = Some(a.id.clone());
                    outcome.account_name = Some(a.name.clone());
                    outcome.provider = Some(a.provider);
                    outcome.model = Some(if done.model.is_empty() { model } else { done.model.clone() });
                    outcome.usage = Some(done.usage.clone());
                    outcome.estimated_cost = cost;
                    outcome.stop_reason = done.stop_reason.clone();
                    return Ok(outcome);
                }
                None => ProviderFailure {
                    category: ErrorCategory::Unknown,
                    http_status: Some(200),
                    code: None,
                    message: "The provider's response couldn't be read.".into(),
                    retry_after: None,
                    // Output was produced; never replay.
                    replay_safe: false,
                },
            },
            Ok(resp) => {
                let f = a.provider.classify(&resp, None);
                let limits = rate_limit_headers(&resp.headers);
                if !limits.is_empty() {
                    let _ = db.with_conn(|c| accounts::record_rate_limits(c, &a.id, &json!({ "headers": limits, "observedAt": now_ms() })));
                }
                f
            }
            Err(e) => transport_failure(&e),
        };

        record_event(db, &req.request_id, &a, &model, &purpose, attempts, started, None, Some(&failure), None);
        outcome.attempts.push(Attempt {
            account_id: a.id.clone(),
            account_name: a.name.clone(),
            model: model.clone(),
            ok: false,
            category: Some(failure.category),
            message: Some(failure.message.clone()),
            duration_ms: now_ms() - started,
        });

        // Short rate-limit or overload waits: retry the same account.
        let short_wait = match failure.category {
            ErrorCategory::RateLimited => failure.retry_after.filter(|s| *s <= pol.max_wait),
            ErrorCategory::Overloaded => Some(failure.retry_after.unwrap_or(1.5).min(pol.max_wait)),
            _ => None,
        };
        if let Some(secs) = short_wait {
            if tries_on_current < 2 && failure.replay_safe && replayable {
                if !svc.wait(&req.request_id, secs) {
                    return Ok(fail(&mut outcome, simple_failure(ErrorCategory::Unknown, "Cancelled.")));
                }
                continue;
            }
        }

        db.with_conn(|c| accounts::record_failure(c, &a.id, failure.category, &failure.message, failure.retry_after))?;
        let can_switch = match failure.category {
            ErrorCategory::RateLimited | ErrorCategory::InsufficientQuota | ErrorCategory::SpendLimit | ErrorCategory::InvalidKey | ErrorCategory::Permission => true,
            // Provider-wide trouble: another key of the same provider won't help.
            ErrorCategory::Overloaded => pol.cross_provider,
            _ => false,
        };
        if !can_switch || pol.mode == "manual" {
            return Ok(fail(&mut outcome, failure));
        }
        if !failure.replay_safe || !replayable {
            let mut f = failure;
            f.message = format!("{} This request can't be retried automatically, so no other account was tried.", f.message);
            return Ok(fail(&mut outcome, f));
        }
        if failure.category.pool_wide() {
            if let Some(p) = a.pool() {
                failed_pools.insert(p);
            }
        }
        if failure.category == ErrorCategory::Overloaded {
            // Only another provider can help.
            let p = a.provider;
            let rest: Vec<Account> = queue.drain(idx + 1..).filter(|x| x.provider != p).collect();
            queue.extend(rest);
        }
        let next = queue[idx + 1..].iter().find(|n| !n.pool().is_some_and(|p| failed_pools.contains(&p))).cloned();
        for skipped in queue[idx + 1..].iter().take_while(|n| Some(n.id.as_str()) != next.as_ref().map(|x| x.id.as_str())) {
            outcome.warnings.push(format!("Skipped {}: it shares a usage pool with an account that just hit its limit.", skipped.name));
        }
        record_switch(db, &req.request_id, &a, next.as_ref(), failure.category, &failure.message);
        match next {
            Some(n) => {
                outcome.switches.push(Switch { from: a.name.clone(), to: n.name.clone(), reason: failure.category.label().into() });
                idx = queue.iter().position(|x| x.id == n.id).unwrap_or(idx + 1);
                tries_on_current = 0;
            }
            None => {
                let mut f = failure;
                f.message = format!("{} No other eligible account is available.", f.message);
                return Ok(fail(&mut outcome, f));
            }
        }
    }
    Ok(fail(&mut outcome, simple_failure(ErrorCategory::Unknown, "No account could serve this request.")))
}

// ------------------------------------------------------------ connection test

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    /// authenticated | auth_failed | permission | unavailable | rate_limited
    /// | quota | network | unknown
    pub outcome: String,
    pub message: String,
    pub http_status: Option<u16>,
    pub models: Vec<String>,
    pub pool: Option<String>,
}

/// Tests a key that hasn't been saved (Add Account dialog). Nothing is stored.
pub fn test_unsaved(db: &impl Db, svc: &AiService, provider: Provider, key: super::vault::Secret, endpoint: &Endpoint) -> AppResult<Validation> {
    let network = db.with_conn(|c| Ok(settings::get_or(c, "privacy.network", true)))?;
    if !network {
        return Ok(Validation { outcome: "network".into(), message: "External network requests are turned off in Privacy settings.".into(), http_status: None, models: vec![], pool: None });
    }
    let http = provider.models_request(&key, endpoint);
    let sent = svc.transport.send(&http);
    drop(http);
    Ok(match sent {
        Ok(resp) if resp.status == 200 => {
            let models = provider.parse_models(&resp.body);
            Validation {
                outcome: "authenticated".into(),
                message: format!("{} accepted the key. {} models available.", provider.name(), models.len()),
                http_status: Some(200),
                pool: provider.observed_pool(&resp.headers),
                models,
            }
        }
        Ok(resp) => {
            let f = provider.classify(&resp, Some(&key));
            let outcome = match f.category {
                ErrorCategory::InvalidKey => "auth_failed",
                ErrorCategory::Permission => "permission",
                ErrorCategory::RateLimited => "rate_limited",
                ErrorCategory::InsufficientQuota | ErrorCategory::SpendLimit => "quota",
                ErrorCategory::Overloaded => "unavailable",
                _ => "unknown",
            };
            Validation { outcome: outcome.into(), message: f.message, http_status: f.http_status, models: vec![], pool: None }
        }
        Err(e) => Validation { outcome: "network".into(), message: transport_failure(&e).message, http_status: None, models: vec![], pool: None },
    })
}

/// Validates a key with a no-cost authenticated call (list models). Never
/// claims success from the key's format alone.
pub fn test_connection(db: &impl Db, svc: &AiService, id: &str) -> AppResult<Validation> {
    let (a, network) = db.with_conn(|c| Ok((accounts::get(c, id)?, settings::get_or(c, "privacy.network", true))))?;
    if !network {
        return Ok(Validation { outcome: "network".into(), message: "External network requests are turned off in Privacy settings.".into(), http_status: None, models: vec![], pool: None });
    }
    let Some(key) = svc.vault.get(&a.credential_ref())? else {
        db.with_conn(|c| accounts::record_failure(c, id, ErrorCategory::InvalidKey, "Key missing from this device's credential store", None))?;
        return Ok(Validation { outcome: "auth_failed".into(), message: "The key isn't in this device's credential store. Enter it again.".into(), http_status: None, models: vec![], pool: None });
    };
    let endpoint = Endpoint { base_url: None, organization_id: a.organization_id.clone(), project_ref: a.project_ref.clone() };
    let http = a.provider.models_request(&key, &endpoint);
    let started = now_ms();
    let sent = svc.transport.send(&http);
    drop(http);
    let result = match sent {
        Ok(resp) if resp.status == 200 => {
            let models = a.provider.parse_models(&resp.body);
            let pool = a.provider.observed_pool(&resp.headers);
            let limits = rate_limit_headers(&resp.headers);
            let limits = (!limits.is_empty()).then(|| json!({ "headers": limits, "observedAt": now_ms() }));
            db.with_conn(|c| accounts::record_success(c, id, pool.as_deref(), limits.as_ref(), Some(&models), true))?;
            Validation {
                outcome: "authenticated".into(),
                message: format!("{} accepted the key. {} models available.", a.provider.name(), models.len()),
                http_status: Some(200),
                models,
                pool,
            }
        }
        Ok(resp) => {
            let f = a.provider.classify(&resp, Some(&key));
            db.with_conn(|c| {
                accounts::record_failure(c, id, f.category, &f.message, f.retry_after)?;
                c.execute("UPDATE ai_accounts SET last_checked_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
                Ok(())
            })?;
            let outcome = match f.category {
                ErrorCategory::InvalidKey => "auth_failed",
                ErrorCategory::Permission => "permission",
                ErrorCategory::RateLimited => "rate_limited",
                ErrorCategory::InsufficientQuota | ErrorCategory::SpendLimit => "quota",
                ErrorCategory::Overloaded => "unavailable",
                _ => "unknown",
            };
            Validation { outcome: outcome.into(), message: f.message, http_status: f.http_status, models: vec![], pool: None }
        }
        Err(e) => {
            let f = transport_failure(&e);
            Validation { outcome: "network".into(), message: f.message, http_status: None, models: vec![], pool: None }
        }
    };
    drop(key);
    let cat = (result.outcome != "authenticated").then(|| result.outcome.clone());
    let _ = db.with_conn(|c| {
        c.execute(
            "INSERT INTO ai_usage_events(request_id, account_id, provider, purpose, started_at, duration_ms, success, error_category, http_status)
             VALUES (?1, ?2, ?3, 'validation', ?4, ?5, ?6, ?7, ?8)",
            params![crate::util::new_id(), id, a.provider.as_str(), started, now_ms() - started, cat.is_none() as i64, cat, result.http_status],
        )?;
        Ok(())
    });
    Ok(result)
}
