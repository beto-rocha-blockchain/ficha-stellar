/**
 * App-wide configuration. One place for every network-dependent value.
 *
 * The active network is a runtime setting (Ajustes → Rede), testnet by default.
 * Read it with `useNetwork()` (React) or `getNetworkConfig()` (plain code),
 * both in src/stellar/network.ts. Never hard-code a Horizon URL or passphrase.
 */
import { Networks } from "@stellar/stellar-sdk";

export type NetworkId = "testnet" | "public";

export interface AssetRef {
  code: string;
  /** null = native XLM. */
  issuer: string | null;
}

export interface NetworkConfig {
  id: NetworkId;
  /** Short badge text in the header. */
  label: "TESTNET" | "MAINNET";
  passphrase: string;
  horizonUrl: string;
  /** Friendbot funds new testnet accounts; null on the public network. */
  friendbotUrl: string | null;
  /** stellar.expert segment for explorer links. */
  explorerSegment: "testnet" | "public";
  /** The USDC the app accepts as "saldo" (matched by code AND issuer, never code alone). */
  usdc: AssetRef & { code: "USDC"; issuer: string };
  /**
   * Signed station registry published on the Ficha site (SITE_URL), fetched
   * first; its detached signature is at `<url>.sig`. null = none published for
   * this network yet: the app uses the bundled copy below.
   */
  liveRegistryUrl: string | null;
  /** The bundled copy, served by the app itself (copied from ../registry at build): the fallback. */
  registryUrl: string;
  registrySigUrl: string;
  /**
   * Pinned registry public key (contract §2). A registry whose detached
   * signature does not verify against this key MUST be rejected.
   * null = no registry for this network yet: treat every station as unknown.
   */
  registryKey: string | null;
  /** SEP-24 anchor home domain for buying saldo; null = no anchor on this network. */
  anchorDomain: string | null;
  /** Letter used in the receipt QR `n=` field (contract §3). */
  receiptNet: "t" | "p";
  /** Custody mode (contract §7); null = not on this network (direct payments only). */
  custody: CustodyConfig | null;
}

export interface CustodyConfig {
  /** Soroban RPC: contract reads, simulation, sending and events (no key, no Ficha backend). */
  rpcUrl: string;
  /** The FichaEscrow deployment on this network (contract §7.1), the one the registry names today. */
  escrowContract: string;
  /**
   * Wasm sha256 (hex) of the FichaEscrow builds the app calls: the registry's
   * `escrow` must run one of them (contract §7.4 step 2). A redeploy of the
   * same build keeps its hash; other code is refused.
   */
  escrowWasm: readonly string[];
  /** XLM's Stellar Asset Contract on this network (Asset.native().contractId(passphrase)). */
  xlmSac: string;
}

/**
 * The Ficha site (the Vercel project "ficha", npm run build:site): the web app,
 * the live signed registry, and the receipt links the station prints
 * (APP_URL = this without the trailing slash; contract §3).
 */
export const SITE_URL = "https://ficha-stellar.vercel.app/";

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    id: "testnet",
    label: "TESTNET",
    passphrase: Networks.TESTNET,
    horizonUrl: import.meta.env.VITE_HORIZON_TESTNET ?? "https://horizon-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
    explorerSegment: "testnet",
    usdc: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    liveRegistryUrl: `${SITE_URL}registry/stations.json`,
    registryUrl: `${import.meta.env.BASE_URL}registry/stations.json`,
    registrySigUrl: `${import.meta.env.BASE_URL}registry/stations.json.sig`,
    registryKey: "GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA",
    anchorDomain: "testanchor.stellar.org",
    receiptNet: "t",
    custody: {
      rpcUrl: import.meta.env.VITE_RPC_TESTNET ?? "https://soroban-testnet.stellar.org",
      escrowContract: "CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC",
      // Only the current build: a claim never touches the host's account (01871cc7... let a host fail
      // claims by changing its account; 94f3dc49... spoke another interface).
      escrowWasm: ["d4314635246e3a17b65d154bd8bae208a94a2594741ed12f3a24198d1e9bd865"],
      xlmSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  },
  public: {
    id: "public",
    label: "MAINNET",
    passphrase: Networks.PUBLIC,
    horizonUrl: import.meta.env.VITE_HORIZON_PUBLIC ?? "https://horizon.stellar.org",
    friendbotUrl: null,
    explorerSegment: "public",
    usdc: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    liveRegistryUrl: `${SITE_URL}registry/stations.public.json`,
    registryUrl: `${import.meta.env.BASE_URL}registry/stations.public.json`,
    registrySigUrl: `${import.meta.env.BASE_URL}registry/stations.public.json.sig`,
    // The public registry's own key (contract §2), never the testnet one.
    registryKey: "GC2GUQLX6M6LI7ZYWOVROJAFV6EEZFOVSHCODC7TVAUOIBKEE47E3ZFG",
    anchorDomain: null,
    receiptNet: "p",
    // Direct payments only until the contract is audited (contract §7).
    custody: null,
  },
};

export const DEFAULT_NETWORK: NetworkId = "testnet";

export function isNetworkId(v: unknown): v is NetworkId {
  return v === "testnet" || v === "public";
}

/** Wallet timing and key-protection constants (see src/wallet/README in app/README.md). */
export const WALLET = {
  /** SEP-5 account index used for the single account the app shows. */
  accountIndex: 0,
  pinMinLength: 6,
  pbkdf2Iterations: 600_000,
  /** Wrong PINs in a row allowed before each further try has to wait (src/wallet/pinguard.ts). */
  pinFreeTries: 5,
  /** Wait after try pinFreeTries, pinFreeTries + 1, ...; the last value repeats. */
  pinWaitsMs: [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000],
  /** Lock after this long without any touch or key press. */
  idleLockMs: 5 * 60_000,
  /** Lock after the app has been in the background this long. */
  hiddenLockMs: 60_000,
} as const;

/** Explorer link for an account or transaction on the given network. */
export function explorerUrl(net: NetworkConfig, kind: "account" | "tx" | "contract", id: string): string {
  return `https://stellar.expert/explorer/${net.explorerSegment}/${kind}/${id}`;
}
