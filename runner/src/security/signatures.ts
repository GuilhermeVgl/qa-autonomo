/** What an application's own error page gives away. Each is specific enough to be rare in ordinary content. */

export const SQL_ERRORS: { re: RegExp; engine: string }[] = [
  { re: /you have an error in your sql syntax/i, engine: "MySQL" },
  { re: /warning:\s*mysqli?_/i, engine: "MySQL" },
  { re: /unknown column '[^']+' in '(?:where|field) (?:clause|list)'/i, engine: "MySQL" },
  { re: /unclosed quotation mark after the character string/i, engine: "SQL Server" },
  { re: /incorrect syntax near/i, engine: "SQL Server" },
  { re: /system\.data\.sqlclient\.sqlexception|microsoft ole db provider for sql server|\[microsoft\]\[odbc/i, engine: "SQL Server" },
  { re: /quoted string not properly terminated|ORA-\d{5}/, engine: "Oracle" },
  { re: /PG::[A-Za-z]*Error|org\.postgresql\.util\.PSQLException|syntax error at or near|unterminated quoted string at or near/i, engine: "PostgreSQL" },
  { re: /sqlite3?::(?:sql)?exception|sqlite3?\.(?:operational|programming)error|unrecognized token: "/i, engine: "SQLite" },
  { re: /SQLSTATE\[[0-9A-Z]+\]/i, engine: "PDO" },
  { re: /ActiveRecord::StatementInvalid|java\.sql\.SQL\w*Exception|SQLSyntaxErrorException|Npgsql\.\w+Exception/, engine: "ORM" },
];

/** First SQL engine whose error message the text shows, if any. */
export function sqlError(text: string): string | null {
  for (const s of SQL_ERRORS) if (s.re.test(text)) return s.engine;
  return null;
}

const STACK_TRACES: RegExp[] = [
  /Traceback \(most recent call last\)/,
  /\bat [\w.$<>]+\([\w.$]+\.java:\d+\)/,
  /Exception in thread "/,
  /\bat (?:System|Microsoft)\.[\w.]+\(/,
  /Server Error in '[^']*' Application/,
  /\b(?:Fatal|Parse) error: .{0,200} in \S+\.php on line \d+/i,
  /Stack trace:\s*#0 /i,
  /You're seeing this error because you have DEBUG = True/,
  /Werkzeug Debugger|The debugger caught an exception/,
  /ActionController::\w+Error|Rails\.root:|Application Trace/,
  /\bat (?:Object|Module|Function)\.<anonymous> \(\S+:\d+:\d+\)|\bat \S+ \((?:\/|[A-Z]:\\)\S+\.(?:js|ts):\d+:\d+\)/,
  /Whoops! There was an error|Illuminate\\\w+/,
];

/** The text of a page shows an unhandled exception: where the code lives and how it is built. */
export function showsStackTrace(text: string): boolean {
  return STACK_TRACES.some((re) => re.test(text));
}

/** "Index of /x": a web server listing a directory. */
export function isDirectoryListing(text: string): boolean {
  return /^\s*Index of \/\S*/m.test(text) && /Parent Directory|Last modified|\bName\b.*\bSize\b/i.test(text);
}

/** A cut of the text around the first match of `re`, for evidence. */
export function around(text: string, re: RegExp, radius = 100): string {
  const m = re.exec(text);
  if (!m) return "";
  const from = Math.max(0, m.index - radius);
  return text.slice(from, Math.min(text.length, m.index + m[0].length + radius)).replace(/\s+/g, " ").trim();
}

/** Where the application names itself and its version: not a hole, a map for whoever looks for one. */
export function bannerOf(headers: Record<string, string>): string | null {
  const server = headers["server"] ?? "";
  const powered = headers["x-powered-by"] ?? "";
  const asp = headers["x-aspnet-version"] ?? headers["x-aspnetmvc-version"] ?? "";
  const parts: string[] = [];
  if (/\d+\.\d+/.test(server)) parts.push(`Server: ${server}`);
  if (powered) parts.push(`X-Powered-By: ${powered}`);
  if (asp) parts.push(`X-AspNet-Version: ${asp}`);
  return parts.length > 0 ? parts.join("; ") : null;
}
