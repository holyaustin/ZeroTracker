/** Parses what a driver pastes or taps: the manager's link, or a zerotracker:// deep link. Pure and unit-tested. */
export type DriverLink = { baseUrl: string; token: string };
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function parseDriverLink(input: string): DriverLink | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || text.length > 2048) return null;
  // zerotracker://d/<token>?base=https%3A%2F%2Fhost  (deep link produced by the web page's "Open in app" button)
  const deep = /^zerotracker:\/\/d\/([^?#/]+)\?(?:.*&)?base=([^&#]+)/i.exec(text);
  if (deep) return build(decodeURIComponent(deep[2]), deep[1]);
  // https://host[:port][/prefix]/d/<token>
  const web = /^(https?:\/\/[^/?#\s]+(?:\/[^?#\s]*?)?)\/d\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(text);
  if (web) return build(web[1], web[2]);
  return null;
}

function build(baseRaw: string, token: string): DriverLink | null {
  if (!TOKEN_RE.test(token)) return null;
  let u: URL;
  try { u = new URL(baseRaw); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname))) return null;   // never send a driver link over plain http to a real host
  return { baseUrl: u.origin + u.pathname.replace(/\/+$/, ""), token };
}
const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "10.0.2.2" || /^192\.168\./.test(h) || /^10\./.test(h);
