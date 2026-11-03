// Masking and cleaning applied to every transcript string that leaves the server.
// Card, IBAN, Emirates ID, account, passport and secret patterns: transcripts carry shell commands, env dumps,
// task definitions and tool output.

// Separators typed inside long numbers: one or two spaces (no-break and narrow ones too), a hyphen or a dash,
// a dot or a slash.
const SPACE = String.raw`[ \t\u00A0\u2007\u202F]{1,2}`;
const DASH = String.raw`[-\u2010\u2011\u2013\u2014]`;
const ANY_SEPARATOR = String.raw`(?:${SPACE}|${DASH}|[./])?`;
// A letter or digit glued in front protects a number (ids such as r5385…); markdown around it does not.
const START = "(?<![A-Za-z0-9])";

const EMIRATES_ID = new RegExp(String.raw`${START}784${ANY_SEPARATOR}\d{4}${ANY_SEPARATOR}\d{7}${ANY_SEPARATOR}\d(?!\d)`, "g");
// Printed IBANs: country + check digits, then groups of four (spaced, dashed or not).
const IBAN_SEPARATOR = String.raw`(?:${SPACE}|-)?`;
const IBAN = new RegExp(
  String.raw`${START}([A-Z]{2}\d{2})((?:${IBAN_SEPARATOR}[A-Z0-9]{4}){2,7}(?:${IBAN_SEPARATOR}[A-Z0-9]{1,4})?)(?![A-Za-z0-9])`,
  "g",
);
// Account numbers named as such ("compte `1234…`", "account no. 1234…").
const ACCOUNT = /(?<![A-Za-z])(compte|account|acct|a\/c)(\s*(?:n°|no\.?|#|:)?\s*`?)(\d[\d \u00A0\u2007\u202F-]{6,}\d)/gi;
// Passport numbers named as such ("passport no. N1234567").
const PASSPORT = /\b(passport(?:[\s_-]*(?:no\.?|number|num|#))?[\s:#=]*)([A-Z]{1,2}\d{6,8})\b/gi;
/** 13 to 19 digits, optionally grouped with one kind of separator, that the next characters do not continue. */
const cardDigits = (separator: string): string => String.raw`\d(?:(?:${separator})?\d){12,18}(?!(?:${separator})?\d)`;
// A number inside a URL path or a key=value id (tweet ids, run ids) is not a card,
// and only digits that pass the Luhn check are: transcripts are full of long numeric ids.
const CARD = new RegExp(`(?<![A-Za-z0-9/_=#.-])(?:${[SPACE, DASH, String.raw`\.`, "/"].map(cardDigits).join("|")})`, "g");

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Vendor key formats: the recognisable prefix is kept, the rest hidden. */
const VENDOR_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-****"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_****"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "sk-****"],
  [/\b(gh[pousr])_[A-Za-z0-9]{20,}/g, "$1_****"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_****"],
  [/\b(xox[abprs])-[A-Za-z0-9-]{10,}/g, "$1-****"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1****"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza****"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "eyJ****"],
];
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;
// A bare 40-character secret access key, looked for only next to an access key id: base64 ids are common elsewhere.
// Git hashes have no capitals.
const AWS_SECRET = /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])[A-Za-z0-9/+]{40}/g;
// Authorization headers with any scheme ("Token …", "Custom-oauthtoken …") or none; quotes may be JSON-escaped.
const AUTH_HEADER = /\b((?:Proxy-)?Authorization\\?["']?\s*[:=]\s*\\?["']?)(?:([A-Za-z][A-Za-z0-9_-]*)(\s+))?([^\s"'`\\]{6,})/gi;
const BEARER = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{12,}/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// Names that hold a secret: ending in a secret-ish word ("input_tokens" does not), in *_KEY / *_AUTH, or credentials.
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*?(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|secret[_-]?string|[_.-]key|[_.-]auth|(?<![A-Za-z0-9])auth|credentials?)`;
// NAME=value, "name": "value", name: value, and the same inside escaped JSON (\"name\":\"value\"). A quoted value is
// hidden up to its closing quote, spaces included; a bare one up to the next separator.
const NAMED_SECRET = new RegExp(
  String.raw`\b(${SECRET_NAME})(?![A-Za-z0-9])(\\?["']?\s*[=:]\s*)(?:(\\?["'])[^"'\\\n]+|[^\s"'\`&,;)}\]\\]{6,})`,
  "gi",
);
// Env entries of ECS task definitions and similar: {"name": "APP_CLIENT_SECRET", "value": "…"}.
const QUOTE = String.raw`\\?"`;
const NAME_VALUE = new RegExp(
  String.raw`(${QUOTE}name${QUOTE}\s*:\s*${QUOTE}[^"\\]*?(?:secret|token|password|passwd|pwd|key|auth|credential)[^"\\]*${QUOTE}\s*,\s*${QUOTE}value${QUOTE}\s*:\s*${QUOTE})[^"\\]+`,
  "gi",
);
// Command-line flags: --password x, --client-secret=x, --api-key x ("--password-stdin" and "--key" are not).
const CLI_SECRET = /(?<![A-Za-z0-9-])(--(?:[A-Za-z0-9]+-)*(?:password|passwd|token|secret|auth)|--(?:[A-Za-z0-9]+-)+key)(=|\s+)(?!-)(\\?["']?)[^\s"'`\\]{4,}/gi;

function lastFour(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").slice(-4);
}

export function maskSensitive(text: string): string {
  const awsKeyId = AWS_KEY_ID.test(text);
  let out = text.replace(PEM, "-----PRIVATE KEY ****-----");
  for (const [pattern, replacement] of VENDOR_KEYS) out = out.replace(pattern, replacement);
  if (awsKeyId) out = out.replace(AWS_SECRET, "****");
  return out
    .replace(AUTH_HEADER, (_match, glue: string, scheme: string | undefined, gap: string | undefined) => `${glue}${scheme ?? ""}${gap ?? ""}****`)
    .replace(BEARER, "$1$2****")
    .replace(URL_CREDENTIALS, "$1:****@")
    .replace(NAME_VALUE, "$1****")
    .replace(NAMED_SECRET, (_match, name: string, glue: string, quote: string | undefined) => `${name}${glue}${quote ?? ""}****`)
    .replace(CLI_SECRET, "$1$2$3****")
    .replace(PASSPORT, (_match, label: string, number: string) => `${label}**** ${lastFour(number)}`)
    .replace(EMIRATES_ID, "784-****-*******-*")
    .replace(IBAN, (match, head: string, body: string) => {
      const digits = body.replace(/\D/g, "").length;
      return digits >= 8 ? `${head} **** **** ${lastFour(body)}` : match;
    })
    .replace(ACCOUNT, (_match, label: string, glue: string, digits: string) => `${label}${glue}**** ${lastFour(digits)}`)
    .replace(CARD, (match) => (luhn(match.replace(/\D/g, "")) ? `**** ${lastFour(match)}` : match));
}

// ANSI escapes first (colour codes in tool output), then every control character but newline and tab.
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function stripControl(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROL, "");
}

/** Cuts at a word boundary when one is close, and adds an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.8 ? cut.slice(0, space) : cut}…`;
}

/** Room left after the cut so that a number straddling it is still seen whole by the mask. */
const MASK_MARGIN = 80;

/** Multi-line display text: controls stripped, home shortened, masked, then cut to `max`. */
export function displayBlock(text: string, max: number, home: string): string {
  const head = stripControl(text.length > max + MASK_MARGIN ? text.slice(0, max + MASK_MARGIN) : text);
  return truncate(maskSensitive(shortenHome(head, home)).trim(), max);
}

/** One-line display text: like displayBlock with every run of whitespace collapsed. */
export function displayLine(text: string, max: number, home: string): string {
  const head = text.length > max * 2 + MASK_MARGIN ? text.slice(0, max * 2 + MASK_MARGIN) : text;
  return truncate(maskSensitive(shortenHome(stripControl(head), home)).replace(/\s+/g, " ").trim(), max);
}

export function shortenHome(text: string, home: string): string {
  if (!home || home === "/") return text;
  return text.split(`${home}/`).join("~/");
}
