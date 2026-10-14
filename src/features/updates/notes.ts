// Release notes as shown inside Kern after updating.

/** Compares dotted versions ("0.1.10" > "0.1.9"); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, "").split("-", 2);
    return { parts: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The parts of a release's notes worth reading once installed: without a
 * leading "What's new" heading (the dialog has its own title) and without the
 * "Install" section.
 */
export function inAppNotes(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const h2 = /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (h2) skipping = /^(install|installation|downloads?)\b/i.test(h2[1]);
    if (!skipping) out.push(line);
  }
  let text = out.join("\n").trim();
  text = text.replace(/^#{1,2}\s+what['’]?s new\s*\n+/i, "");
  return text.trim();
}
