/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Copy-and-paste code for sending to a stream, generated from its settings:
// an HTML form and a fetch() call for public streams, and cURL, Node and
// Python for token and signature streams. Also builds a sample submission
// from the stream's fields for previews and test sends.

import type { Stream, StreamConfig, StreamField } from "@/lib/types";

export type SnippetKind = "html" | "fetch" | "curl" | "node" | "python";

export const SNIPPET_LABEL: Record<SnippetKind, string> = { html: "HTML form", fetch: "JavaScript", curl: "cURL", node: "Node.js", python: "Python" };

/** The snippets that make sense for an authentication mode. */
export function snippetKinds(cfg: StreamConfig): SnippetKind[] {
  return cfg.security.auth === "public" ? ["html", "fetch", "curl"] : ["curl", "node", "python"];
}

function sampleValue(f: StreamField): unknown {
  const name = (f.label || f.key).toLowerCase();
  switch (f.type) {
    case "email":
      return "someone@example.com";
    case "url":
      return "https://example.com/page";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "choice":
      return f.options[0] ?? "";
    case "long_text":
      return `Example ${name}.`;
    default:
      return f.key === "title" ? "Something went wrong" : `Example ${name}`;
  }
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** An example submission that satisfies the stream's fields. */
export function samplePayload(cfg: StreamConfig): Record<string, unknown> {
  if (!cfg.fields.list.length) return { title: "Something went wrong", message: "Example message." };
  const out: Record<string, unknown> = {};
  for (const f of cfg.fields.list) setPath(out, f.key, sampleValue(f));
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const maxOf = (f: StreamField) => (f.maxLength ? ` maxlength="${f.maxLength}"` : "");

function formField(f: StreamField): string {
  const req = f.required ? " required" : "";
  const label = esc(f.label || f.key);
  const name = esc(f.key);
  switch (f.type) {
    case "long_text":
      return `  <label>${label}\n    <textarea name="${name}"${req}${maxOf(f)}></textarea>\n  </label>`;
    case "choice":
      return `  <label>${label}\n    <select name="${name}"${req}>\n${f.options.map((o) => `      <option>${esc(o)}</option>`).join("\n")}\n    </select>\n  </label>`;
    case "boolean":
      return `  <label><input type="checkbox" name="${name}" value="true"> ${label}</label>`;
    default: {
      const type = f.type === "email" ? "email" : f.type === "url" ? "url" : f.type === "number" ? "number" : "text";
      return `  <label>${label}\n    <input type="${type}" name="${name}"${req}${maxOf(f)}>\n  </label>`;
    }
  }
}

function html(s: Stream): string {
  const cfg = s.config;
  const fields = cfg.fields.list.length ? cfg.fields.list.filter((f) => !f.hidden).map(formField) : [formField({ key: "title", label: "Title", type: "text", required: true, maxLength: 0, options: [], hidden: false }), formField({ key: "message", label: "Message", type: "long_text", required: false, maxLength: 0, options: [], hidden: false })];
  const extra: string[] = [];
  if (cfg.security.honeypotField) {
    extra.push(`  <!-- Leave empty: bots fill this in and are ignored. -->\n  <input name="${esc(cfg.security.honeypotField)}" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">`);
  }
  if (cfg.security.turnstile) {
    extra.push(`  <div class="cf-turnstile" data-sitekey="${esc(cfg.security.turnstileSiteKey ?? "YOUR_TURNSTILE_SITE_KEY")}"></div>`);
  }
  const script = cfg.security.turnstile ? `\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : "";
  return `<form action="${s.url}" method="POST">\n${[...fields, ...extra].join("\n")}\n  <button type="submit">Send</button>\n</form>${script}`;
}

function fetchJs(s: Stream): string {
  const cfg = s.config;
  const keys = new Set(cfg.fields.list.map((f) => f.key));
  const auto: string[] = [];
  if (keys.has("page")) auto.push("page: location.href");
  if (keys.has("browser")) auto.push("browser: navigator.userAgent");
  const turnstile = cfg.security.turnstile ? `\n  // From the Turnstile widget on the page.\n  "cf-turnstile-response": turnstile.getResponse(),` : "";
  return `// Call this from your form or modal, e.g. send({ ${Object.keys(samplePayload(cfg)).slice(0, 2).join(", ")} })
async function send(data) {
  const res = await fetch("${s.url}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data,${auto.length ? ` ${auto.join(", ")},` : ""}${turnstile} }),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.message); // out.fields has per-field problems
  return out; // { ok, id, message }
}`;
}

function curl(s: Stream): string {
  const body = JSON.stringify(samplePayload(s.config)).replace(/'/g, "'\\''");
  const auth = s.config.security.auth;
  const headers = ['-H "Content-Type: application/json"'];
  if (auth === "public") headers.push(`-H "Origin: ${s.config.security.allowedOrigins.find((o) => !o.includes("*")) ?? "https://example.com"}"`);
  if (auth === "token") headers.push('-H "Authorization: Bearer $KERN_STREAM_SECRET"');
  if (auth === "signature") {
    return `BODY='${body}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$KERN_STREAM_SECRET" -hex | sed 's/^.* //')
curl -X POST "${s.url}" \\
  -H "Content-Type: application/json" \\
  -H "Kern-Signature: t=$T,v1=$SIG" \\
  --data "$BODY"`;
  }
  return `curl -X POST "${s.url}" \\\n  ${headers.join(" \\\n  ")} \\\n  --data '${body}'`;
}

function node(s: Stream): string {
  const body = JSON.stringify(samplePayload(s.config));
  if (s.config.security.auth === "signature") {
    return `import { createHmac } from "node:crypto";

const body = JSON.stringify(${body});
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.KERN_STREAM_SECRET).update(\`\${t}.\${body}\`).digest("hex");

const res = await fetch("${s.url}", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Kern-Signature": \`t=\${t},v1=\${v1}\`, "Idempotency-Key": crypto.randomUUID() },
  body,
});
console.log(res.status, await res.json());`;
  }
  return `const res = await fetch("${s.url}", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${process.env.KERN_STREAM_SECRET}\`, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(${body}),
});
console.log(res.status, await res.json());`;
}

function python(s: Stream): string {
  const body = JSON.stringify(samplePayload(s.config));
  if (s.config.security.auth === "signature") {
    return `import hashlib, hmac, json, os, time, urllib.request

body = json.dumps(${body}).encode()
t = str(int(time.time()))
v1 = hmac.new(os.environ["KERN_STREAM_SECRET"].encode(), t.encode() + b"." + body, hashlib.sha256).hexdigest()
req = urllib.request.Request("${s.url}", data=body, method="POST", headers={
    "Content-Type": "application/json",
    "Kern-Signature": f"t={t},v1={v1}",
})
print(urllib.request.urlopen(req).read().decode())`;
  }
  return `import json, os, urllib.request

req = urllib.request.Request("${s.url}", data=json.dumps(${body}).encode(), method="POST", headers={
    "Content-Type": "application/json",
    "Authorization": "Bearer " + os.environ["KERN_STREAM_SECRET"],
})
print(urllib.request.urlopen(req).read().decode())`;
}

export function snippet(kind: SnippetKind, s: Stream): string {
  switch (kind) {
    case "html":
      return html(s);
    case "fetch":
      return fetchJs(s);
    case "curl":
      return curl(s);
    case "node":
      return node(s);
    case "python":
      return python(s);
  }
}
