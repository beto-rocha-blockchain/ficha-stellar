/**
 * A judge's first scan (no wallet yet): the pay link survives onboarding,
 * and a testnet wallet is activated where the payment needs it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { activateNewAccount, pendingActivation } from "@/stellar/horizon";
import { clearPendingLink, pendingLink, rememberPendingLink } from "./pending-link";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const P = "v=1&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&s=YX3DGE&x=F3H9TXAB&a=jd7P0m8htvt8yndyQED9mMMwOtc69b8EIoT3Cr3qUZs";

afterEach(() => {
  clearPendingLink();
  vi.unstubAllGlobals();
});

describe("a pay link opened with no wallet", () => {
  it("is kept through /welcome and opened instead of Home", () => {
    rememberPendingLink("/p", `?${P}`);
    expect(pendingLink()).toBe(`/p?${P}`);
    rememberPendingLink("/pay", "uri=web%2Bstellar%3Apay%3Fdestination%3DG");
    expect(pendingLink()).toBe("/pay?uri=web%2Bstellar%3Apay%3Fdestination%3DG");
    clearPendingLink();
    expect(pendingLink()).toBeNull();
  });

  it("keeps only pay links, and only with their query", () => {
    rememberPendingLink("/history", "?x=1");
    rememberPendingLink("/p", "");
    rememberPendingLink("/", "?v=1");
    expect(pendingLink()).toBeNull();
  });

  it("lives in the tab's sessionStorage, so a reload on /welcome keeps it", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    });
    rememberPendingLink("/p", P);
    expect([...kept.values()]).toEqual([`/p?${P}`]);
    clearPendingLink();
    expect(kept.size).toBe(0);
    // Something else written under the key is never opened.
    kept.set("ficha.pendingLink", "https://example.org/p?x=1");
    expect(pendingLink()).toBeNull();
  });

  it("is wired in the root layout: kept on the way to /welcome, opened after it", () => {
    const root = src("../routes/__root.tsx");
    expect(root).toContain("rememberPendingLink(path, searchStr)");
    expect(root).toContain("const pending = pendingLink()");
    expect(root).toContain("<NavigateHref href={pending} />");
  });
});

describe("a new testnet wallet", () => {
  it("is activated with Friendbot right after it is created, never on the public network", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await activateNewAccount(NETWORKS.testnet, "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6")).toBe(true);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("https://friendbot.stellar.org?addr=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6");
    expect(await activateNewAccount(NETWORKS.public, "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Friendbot down: no error, Home still offers it.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await activateNewAccount(NETWORKS.testnet, "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6")).toBe(false);
    expect(src("../routes/welcome.tsx")).toContain("activateNewAccount(net, created)");
  });

  it("can be activated on the pay screens themselves, not only on Home", () => {
    for (const page of ["../routes/p.tsx", "../routes/pay.tsx", "../routes/buy.tsx"]) {
      expect(src(page), page).toContain("<ActivateTestnet onDone=");
    }
  });
});

describe("a new wallet's activation, while Friendbot answers (review R2P11)", () => {
  it("is visible as under way to the pay screens, which wait for it instead of saying 'not active'", async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    vi.stubGlobal("fetch", fetch);
    const key = "GAKINFFB6NVQONE3MA4BZ5X3EEDG6KYNG2WCL2NLJSFP2AAXI5GX6VIP";
    expect(pendingActivation(NETWORKS.testnet, key)).toBeUndefined();
    const run = activateNewAccount(NETWORKS.testnet, key);
    expect(pendingActivation(NETWORKS.testnet, key)).toBe(run);
    // A second start (a tap on Activate meanwhile) joins the one running: one Friendbot call.
    expect(activateNewAccount(NETWORKS.testnet, key)).toBe(run);
    expect(pendingActivation(NETWORKS.public, key)).toBeUndefined();
    answer(new Response("{}", { status: 200 }));
    expect(await run).toBe(true);
    await Promise.resolve();
    expect(pendingActivation(NETWORKS.testnet, key)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const hook = src("../hooks/useAccountSummary.ts");
    expect(hook).toContain("pendingActivation(net, publicKey)");
    expect(hook).toContain("return { data, loading, error, refresh, activating };");
    for (const page of ["../routes/p.tsx", "../routes/pay.tsx"]) {
      expect(src(page), page).toContain("data && !data.funded && summary.activating && (");
      expect(src(page), page).toContain("data && !data.funded && !summary.activating");
    }
  });
});
