import { describe, expect, it } from "vitest";
import type { Stream, StreamConfig, StreamField } from "@/lib/types";
import { samplePayload, snippet, snippetKinds } from "./snippets";

const field = (f: Partial<StreamField> & { key: string }): StreamField => ({ label: "", type: "text", required: false, maxLength: 0, options: [], hidden: false, ...f });

function stream(config: Omit<Partial<StreamConfig>, "security"> & { security?: Partial<StreamConfig["security"]> } = {}): Stream {
  const base = {
    action: "task",
    fields: { mode: "lenient", list: [field({ key: "title", label: "Summary", required: true, maxLength: 200 }), field({ key: "severity", type: "choice", options: ["low", "high"] }), field({ key: "page", type: "url" })] },
    security: { auth: "public", allowedOrigins: ["https://site.dev"], honeypotField: "_hp", turnstile: false, turnstileSiteKey: null },
  } as unknown as StreamConfig;
  return {
    id: "a".repeat(64),
    url: `https://streams.relf.cloud/kern/${"a".repeat(64)}`,
    config: { ...base, ...config, security: { ...base.security, ...config.security } },
  } as Stream;
}

describe("stream snippets", () => {
  it("builds a sample that satisfies the fields", () => {
    expect(samplePayload(stream().config)).toEqual({ title: "Something went wrong", severity: "low", page: "https://example.com/page" });
  });

  it("offers browser snippets for public streams and server snippets otherwise", () => {
    expect(snippetKinds(stream().config)).toEqual(["html", "fetch", "curl"]);
    expect(snippetKinds(stream({ security: { auth: "signature" } }).config)).toEqual(["curl", "node", "python"]);
  });

  it("makes an HTML form with the honeypot and required fields", () => {
    const html = snippet("html", stream());
    expect(html).toContain(`action="https://streams.relf.cloud/kern/${"a".repeat(64)}"`);
    expect(html).toContain('name="title" required maxlength="200"');
    expect(html).toContain("<option>high</option>");
    expect(html).toContain('name="_hp"');
    expect(html).not.toContain("cf-turnstile");
  });

  it("adds Turnstile when the stream uses it", () => {
    const html = snippet("html", stream({ security: { turnstile: true, turnstileSiteKey: "0x4AAA" } }));
    expect(html).toContain('data-sitekey="0x4AAA"');
    expect(html).toContain("challenges.cloudflare.com/turnstile");
  });

  it("fills page details automatically in the fetch snippet", () => {
    expect(snippet("fetch", stream())).toContain("page: location.href");
  });

  it("signs requests in signature mode", () => {
    const s = stream({ security: { auth: "signature" } });
    expect(snippet("curl", s)).toContain("Kern-Signature: t=$T,v1=$SIG");
    expect(snippet("node", s)).toContain('createHmac("sha256"');
    expect(snippet("python", s)).toContain("hmac.new(");
  });

  it("sends the bearer secret in token mode", () => {
    expect(snippet("curl", stream({ security: { auth: "token" } }))).toContain("Authorization: Bearer $KERN_STREAM_SECRET");
  });
});
