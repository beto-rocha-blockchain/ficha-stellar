import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchorError, fetchDepositTx, isDepositGone, jwtExpired, type Anchor } from "./anchor";

const anchor: Anchor = {
  domain: "testanchor.stellar.org",
  webAuthEndpoint: "https://testanchor.stellar.org/auth",
  signingKey: "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR",
  transferServer: "https://testanchor.stellar.org/sep24",
  assets: [],
};

/** fetch that answers every request with `status` and a JSON body. */
function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

async function pollError(): Promise<unknown> {
  return fetchDepositTx(anchor, "jwt", "tx-1").then(
    () => null,
    (e: unknown) => e,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deposit polling errors", () => {
  it("keeps the HTTP status of an anchor error", async () => {
    // What testanchor.stellar.org answers once the SEP-10 JWT has expired.
    answer(403, { error: "forbidden" });
    const e = await pollError();
    expect(e).toBeInstanceOf(AnchorError);
    expect((e as AnchorError).status).toBe(403);
    expect((e as AnchorError).message).toBe("forbidden");
  });

  it("gives up on a refused JWT or an unknown transaction", async () => {
    for (const status of [401, 403, 404]) {
      answer(status, {});
      expect(isDepositGone(await pollError()), String(status)).toBe(true);
    }
  });

  it("keeps polling through server errors and network failures", async () => {
    for (const status of [429, 500, 502, 503]) {
      answer(status, {});
      expect(isDepositGone(await pollError()), String(status)).toBe(false);
    }
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(isDepositGone(await pollError())).toBe(false);
    answer(200, {}); // 200 without a transaction
    expect(isDepositGone(await pollError())).toBe(false);
    expect(isDepositGone(new AnchorError("auth", "no JWT in the answer"))).toBe(false);
  });

  it("knows when the SEP-10 JWT has expired", () => {
    // The test anchor's 403 carries no CORS header, so the WebView only sees a
    // network error: the token's exp is what tells the Buy screen to stop.
    const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = (claims: object) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
    const iat = 1_790_000_000; // seconds
    const token = jwt({ iss: "https://testanchor.stellar.org/auth", sub: "G…", iat, exp: iat + 86_400, jti: "é~?x" }); // needs "-"/"_" and padding
    expect(jwtExpired(token, (iat + 60) * 1000)).toBe(false);
    expect(jwtExpired(token, (iat + 86_399) * 1000)).toBe(false);
    expect(jwtExpired(token, (iat + 86_400) * 1000)).toBe(true);
    expect(jwtExpired(token, (iat + 3 * 86_400) * 1000)).toBe(true);
    // Unreadable or without exp: keep polling and let the anchor's answer decide.
    expect(jwtExpired(jwt({ iat }), (iat + 3 * 86_400) * 1000)).toBe(false);
    expect(jwtExpired("expired.jwt.value")).toBe(false);
    expect(jwtExpired("")).toBe(false);
  });

  it("returns the transaction while the anchor accepts the session", async () => {
    answer(200, { transaction: { id: "tx-1", status: "pending_anchor" } });
    await expect(fetchDepositTx(anchor, "jwt", "tx-1")).resolves.toMatchObject({ status: "pending_anchor" });
  });
});
