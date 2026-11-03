import { describe, expect, it } from "vitest";
import { displayBlock, displayLine, maskSensitive, stripControl } from "../server/mask";

describe("mask", () => {
  it("masks card numbers that pass the Luhn check, not long ids", () => {
    expect(maskSensitive("card 4111 1111 1111 1111 exp 12/29")).toBe("card **** 1111 exp 12/29");
    expect(maskSensitive("4111-1111-1111-1111")).toBe("**** 1111");
    expect(maskSensitive("https://x.com/user/status/1234567890123456789")).toBe("https://x.com/user/status/1234567890123456789");
    expect(maskSensitive("job 1234567890123")).toBe("job 1234567890123");
  });

  it("masks IBAN, Emirates ID and named accounts", () => {
    expect(maskSensitive("IBAN AE07 0331 2345 6789 0123 456")).toBe("IBAN AE07 **** **** 3456");
    expect(maskSensitive("EID 784-1990-1234567-1")).toBe("EID 784-****-*******-*");
    expect(maskSensitive("account no. 1234 5678 90")).toBe("account no. **** 7890");
  });

  it("masks secrets in commands and output", () => {
    const masked = maskSensitive(
      [
        "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' https://api.test",
        "git clone https://user:hunter2secret@github.com/x/y",
        '{"client_secret": "s3cr3tvalue99"}',
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
        "AKIAABCDEFGHIJKLMNOP",
        "input_tokens: 207265",
      ].join("\n"),
    );
    expect(masked).not.toMatch(/abcdefghijklmnop|hunter2secret|s3cr3tvalue99|ghp_abcdef|AKIAABCDEFGH/);
    expect(masked).toContain("ANTHROPIC_API_KEY=****");
    expect(masked).toContain("Bearer ****");
    expect(masked).toContain("https://user:****@github.com");
    expect(masked).toContain("input_tokens: 207265");
  });

  it("masks *_KEY names, flags, auth headers, task definitions and escaped JSON", () => {
    const cases: Array<[string, string]> = [
      ["PAYMENT_AUTH_KEY=payvalue123", "PAYMENT_AUTH_KEY=****"],
      ["MAIL_SECRET_KEY=mailvalue1234", "MAIL_SECRET_KEY=****"],
      ["SECRET_KEY=django-value", "SECRET_KEY=****"],
      ["ENCRYPTION_KEY=0123456789abcdef", "ENCRYPTION_KEY=****"],
      ["mysql --password hunter22 -h db", "mysql --password **** -h db"],
      ["cli --client-secret=abcd1234 --region us-east-1", "cli --client-secret=**** --region us-east-1"],
      ["curl -H 'Authorization: Token abcdef123456'", "curl -H 'Authorization: Token ****'"],
      ['{"Authorization": "Custom-oauthtoken abcdef.123456"}', '{"Authorization": "Custom-oauthtoken ****"}'],
      ['{"name": "OAUTH_CLIENT_SECRET", "value": "oauthvalue99"}', '{"name": "OAUTH_CLIENT_SECRET", "value": "****"}'],
      ['{\n  "name": "PAYMENT_AUTH_KEY",\n  "value": "pay v2"\n}', '{\n  "name": "PAYMENT_AUTH_KEY",\n  "value": "****"\n}'],
      ['"SecretString": "{\\"OAUTH_CLIENT_SECRET\\":\\"oauthvalue99\\"}"', '"SecretString": "****\\"OAUTH_CLIENT_SECRET\\":\\"****\\"}"'],
      ['DB_PASSWORD="two words"', 'DB_PASSWORD="****"'],
      ["passport no. N1234567 expires", "passport no. **** 4567 expires"],
      ["AKIAABCDEFGHIJKLMNOP wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AKIA**** ****"],
    ];
    for (const [input, expected] of cases) expect(maskSensitive(input), input).toBe(expected);
  });

  it("leaves look-alikes alone", () => {
    for (const input of [
      "docker login --password-stdin",
      "mkdir -p /tmp/x",
      "commit 3f786850e387550fdab836ed7e6dc881de23001b",
      "oauth: enabled",
      '{"name": "NODE_ENV", "value": "production"}',
      "monkey=bananas123",
      "max_tokens: 4096",
    ]) {
      expect(maskSensitive(input), input).toBe(input);
    }
  });

  it("strips control characters and ANSI colours, keeps newlines and tabs", () => {
    expect(stripControl("\u001b[31mred\u001b[0m\r\nnext\tcol\u0007\u0000")).toBe("red\nnext\tcol");
  });

  it("shortens home, collapses lines and caps length", () => {
    expect(displayLine("  /Users/me/project/file.ts\n  more  ", 160, "/Users/me")).toBe("~/project/file.ts more");
    const long = displayBlock("word ".repeat(400), 100, "/Users/me");
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("…")).toBe(true);
  });
});
