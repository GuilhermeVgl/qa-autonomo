/** How serious a security finding is. Matches the severities of bugs. */
export type Severity = "critical" | "high" | "normal";

/** What the driver reads from a page for the security checks: only what the checks need, nothing a person typed. */
export interface PageFacts {
  /** Headers of the page's own response, lower-cased. */
  headers: Record<string, string>;
  /** The page is an HTML document (headers such as CSP only matter there). */
  html: boolean;
  forms: FormFacts[];
  /** A `<meta name="csrf-token">`: how Rails and others hand the token to their scripts. */
  metaCsrf: boolean;
  /** Resources an https page loads over plain http (a few examples). */
  mixed: string[];
  /** The visible text of the page, cut: where error messages and stack traces show. */
  text: string;
}

export interface FormFacts {
  method: string;
  /** Absolute address the form sends to. */
  action: string;
  label: string;
  /** Names of the hidden fields (where an anti-CSRF token lives); never their values. */
  hidden: string[];
  fields: { name: string; type: string }[];
  password: boolean;
}

/** The flags of a cookie as the application sent them. `unset` means the application said nothing about SameSite. */
export interface CookieFlag {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none" | "unset";
}

/** What loading an address with injected markers showed. */
export interface ProbeOutcome {
  status: number;
  finalUrl: string;
  /** Indices `i` for which an element `<qaxss{i}>` exists in the page: the marker was parsed as markup. */
  injected: number[];
  /** Visible text, cut. */
  text: string;
}

/** A plain GET that does not follow redirects. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  /** First part of the body. */
  body: string;
}

/** Where a security step hangs: the screen's fingerprint (exploration) or its id (regression). */
export type Anchor = { fingerprint: string } | { id: string };

/** What a browser session must offer for the checks that go beyond reading the page. All optional: a session without them is just not probed. */
export interface SecurityCapabilities {
  /** The cookies the application set, with the flags it set them with. */
  cookieFlags?(): CookieFlag[];
  /** Loads an address (GET) and reports what the page made of the injected markers. Never leaves the allowed hosts. */
  probe?(url: string): Promise<ProbeOutcome | null>;
  /** A plain GET that does not follow redirects, for checks that need the raw answer. Never leaves the allowed hosts. */
  rawGet?(url: string, opts?: { origin?: string }): Promise<RawResponse | null>;
}
