const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^(?=.*\d)[0-9a-f]{16,}$/i;
const NUMBER = /^\d+$/;

function isIdSegment(seg: string): boolean {
  return NUMBER.test(seg) || UUID.test(seg) || LONG_HEX.test(seg);
}

/** Route pattern of a URL: query/hash dropped, trailing slash trimmed, ids and UUIDs become `:id`. */
export function routePattern(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean).map((s) => (isIdSegment(s) ? ":id" : s));
  return "/" + segments.join("/");
}
