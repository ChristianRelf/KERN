// Argument lists for saved commands. Commands run without a shell, so
// these only split on whitespace and honour quotes; operators like && are
// passed through as plain arguments.

/** Splits an argument string, honouring quotes: `run "my file"` → ["run", "my file"]. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

export const joinArgs = (args: string[]) => args.map((a) => (/[\s"']/.test(a) || a === "" ? `"${a.replace(/"/g, "'")}"` : a)).join(" ");

