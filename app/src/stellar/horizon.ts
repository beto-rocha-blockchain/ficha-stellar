/**
 * Horizon reads. The browser talks to Horizon directly (it serves CORS);
 * there is no Ficha backend.
 */
import { Horizon, NotFoundError } from "@stellar/stellar-sdk";
import type { AssetRef, NetworkConfig } from "@/config";
import { fromStroops, toStroops } from "./amount";

const servers = new Map<string, Horizon.Server>();

/** One shared Horizon.Server per URL. */
export function getServer(net: NetworkConfig): Horizon.Server {
  let s = servers.get(net.horizonUrl);
  if (!s) {
    s = new Horizon.Server(net.horizonUrl);
    servers.set(net.horizonUrl, s);
  }
  return s;
}

/** The account, or null when it does not exist on the ledger yet (not funded). */
export async function loadAccountOrNull(net: NetworkConfig, publicKey: string): Promise<Horizon.AccountResponse | null> {
  try {
    return await getServer(net).loadAccount(publicKey);
  } catch (e) {
    if (e instanceof NotFoundError || (e as { response?: { status?: number } })?.response?.status === 404) return null;
    throw e;
  }
}

export interface BalanceEntry {
  code: string;
  /** null = native XLM */
  issuer: string | null;
  balance: string;
  /** Trustline limit; undefined for XLM. */
  limit?: string;
}

export interface AccountSummary {
  publicKey: string;
  /** false = the account does not exist on the ledger yet. */
  funded: boolean;
  xlm: string;
  /** XLM left after the minimum reserve and open liabilities. */
  spendableXlm: string;
  /** USDC balance (code AND issuer of the configured USDC), or null without a trustline. */
  usdc: string | null;
  /** Every other asset line (shown as "outros", never counted as saldo). */
  others: BalanceEntry[];
  /** The raw account for building transactions; null when not funded. */
  account: Horizon.AccountResponse | null;
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  if (a.issuer === null || b.issuer === null) return a.issuer === b.issuer;
  return a.code === b.code && a.issuer === b.issuer;
}

/**
 * Spendable balance of one asset (matched by code AND issuer): what open
 * offers do not hold. Null without a trustline.
 */
export function balanceOf(summary: AccountSummary, asset: AssetRef): string | null {
  if (!summary.funded) return asset.issuer === null ? "0" : null;
  if (asset.issuer === null) return summary.spendableXlm;
  const line = summary.account?.balances.find(
    (b) => b.asset_type !== "native" && b.asset_type !== "liquidity_pool_shares" && b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
  if (!line || line.asset_type === "native" || line.asset_type === "liquidity_pool_shares") return null;
  const free = toStroops(line.balance) - toStroops(line.selling_liabilities ?? "0");
  return fromStroops(free > 0n ? free : 0n);
}

const BASE_RESERVE = toStroops("0.5");

export function summarize(net: NetworkConfig, publicKey: string, account: Horizon.AccountResponse | null): AccountSummary {
  if (!account) {
    return { publicKey, funded: false, xlm: "0", spendableXlm: "0", usdc: null, others: [], account: null };
  }
  let xlm = "0";
  let xlmSelling = "0";
  let usdc: string | null = null;
  const others: BalanceEntry[] = [];
  for (const b of account.balances) {
    if (b.asset_type === "native") {
      xlm = b.balance;
      xlmSelling = b.selling_liabilities;
    } else if (b.asset_type === "liquidity_pool_shares") {
      continue;
    } else if (b.asset_code === net.usdc.code && b.asset_issuer === net.usdc.issuer) {
      usdc = b.balance;
    } else {
      others.push({ code: b.asset_code, issuer: b.asset_issuer, balance: b.balance, limit: b.limit });
    }
  }
  const entries = BigInt(2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0));
  const spendable = toStroops(xlm) - entries * BASE_RESERVE - toStroops(xlmSelling);
  return {
    publicKey,
    funded: true,
    xlm,
    spendableXlm: fromStroops(spendable > 0n ? spendable : 0n),
    usdc,
    others,
    account,
  };
}

export async function fetchAccountSummary(net: NetworkConfig, publicKey: string): Promise<AccountSummary> {
  return summarize(net, publicKey, await loadAccountOrNull(net, publicKey));
}

/** Activations under way, per network and account: the pay screens wait for one instead of calling the account inactive. */
const activations = new Map<string, Promise<boolean>>();

/**
 * A wallet just created on this phone: on testnet, activate its account with
 * Friendbot's test XLM at once, so the first pay link needs no detour Home.
 * False on a network without Friendbot, or when it failed (Home and the pay
 * screens still offer it). While it runs, pendingActivation returns it.
 */
export function activateNewAccount(net: NetworkConfig, publicKey: string): Promise<boolean> {
  if (!net.friendbotUrl) return Promise.resolve(false);
  const key = `${net.id}|${publicKey}`;
  const running = activations.get(key);
  if (running) return running;
  const run = fundWithFriendbot(net, publicKey).then(
    () => true,
    () => false,
  );
  activations.set(key, run);
  void run.finally(() => activations.delete(key));
  return run;
}

/**
 * The activation of this account still under way (activateNewAccount), if
 * any: a fresh wallet lands on its pending pay link before Friendbot
 * answers (about 3 s), and the page waits for this instead of showing a red
 * "not active" for its next 15 s poll.
 */
export function pendingActivation(net: Pick<NetworkConfig, "id">, publicKey: string): Promise<boolean> | undefined {
  return activations.get(`${net.id}|${publicKey}`);
}

/** Testnet only: ask Friendbot to create and fund the account. */
export async function fundWithFriendbot(net: NetworkConfig, publicKey: string): Promise<void> {
  if (!net.friendbotUrl) throw new Error("Friendbot is testnet only");
  const res = await fetch(`${net.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  // 400 "createAccountAlreadyExist" means it is already funded: fine.
  if (!res.ok && res.status !== 400) throw new Error(`Friendbot HTTP ${res.status}`);
}
