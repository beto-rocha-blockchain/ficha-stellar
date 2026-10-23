/**
 * Host mode's state, kept outside the screens (zustand): the host's view of
 * its stations and sessions (./host.ts loadHostView), and a "release all" in
 * progress. Outside a route, a batch keeps its progress across the lock
 * screen, and coming back to the page shows the last view at once while it
 * reloads.
 *
 *   const ctx = { server: getRpc(net.custody), net, host, registry };
 *   await useHost.getState().load(ctx);
 *   useHost.getState().settled(ctx, session, "deadline", done);   // after this phone's release
 *   useHost.getState().paidOut(ctx, escrow, token);                 // after this phone's pay_host
 */
import { create } from "zustand";
import type { NetworkConfig } from "@/config";
import type { Registry } from "@/registry/verify";
import { compareAmounts, fromStroops } from "@/stellar/amount";
import { fetchAccountSummary } from "@/stellar/horizon";
import { EscrowError } from "./errors";
import type { Rpc, StationTerms } from "./escrow";
import {
  afterPayout,
  afterRegister,
  afterSettle,
  loadHostView,
  releaseMany,
  releaseSession,
  rememberStation,
  settleFromCall,
  type BatchProgress,
  type FeeCheck,
  type HostCallDone,
  type HostSession,
  type HostView,
} from "./host";
import type { Signer } from "./pay";

export interface HostContext {
  server: Rpc;
  net: NetworkConfig;
  /** The wallet's address: the host. */
  host: string;
  registry: Registry | null;
}

interface HostState {
  /** network|host of the view below. */
  key: string | null;
  view: HostView | null;
  loading: boolean;
  error: unknown;
  batch: BatchProgress | null;
  /** Read (again) everything; a view of another network or host is dropped first. */
  load: (ctx: HostContext) => Promise<void>;
  /** A release or host_refund this phone sent went through. */
  settled: (ctx: HostContext, s: HostSession, how: "deadline" | "host", done: HostCallDone, units?: number) => void;
  /** A register this phone sent went through. */
  registered: (ctx: HostContext, escrow: string, station: string, terms: StationTerms) => void;
  /** A pay_host this phone sent went through: nothing more is owed in that token on that escrow. */
  paidOut: (ctx: HostContext, escrow: string, token: string) => void;
  /** Release these sessions one after another (./host.ts releaseMany); one batch at a time. */
  releaseAll: (ctx: HostContext, sessions: HostSession[], sign: Signer, checkFee?: FeeCheck) => Promise<BatchProgress | null>;
  clearBatch: () => void;
}

export const hostViewKey = (net: Pick<NetworkConfig, "id">, host: string) => `${net.id}|${host}`;

// A load that started before this phone settled or registered something
// would bring the old state back: each change makes loads in flight stale.
let generation = 0;

export const useHost = create<HostState>()((set, get) => ({
  key: null,
  view: null,
  loading: false,
  error: null,
  batch: null,

  load: async (ctx) => {
    const key = hostViewKey(ctx.net, ctx.host);
    const mine = ++generation;
    set((s) => (s.key === key ? { loading: true, error: null } : { key, view: null, loading: true, error: null, batch: s.batch?.running ? s.batch : null }));
    try {
      const view = await loadHostView(ctx.server, ctx.net, ctx.host, ctx.registry);
      if (mine === generation) set({ view, loading: false });
    } catch (error) {
      if (mine === generation) set({ loading: false, error });
    }
  },

  settled: (ctx, s, how, done, units = 0) => {
    generation++;
    const { key, view } = get();
    if (key !== hostViewKey(ctx.net, ctx.host) || !view) return;
    set({ view: afterSettle(view, settleFromCall(s, how, done, units)), loading: false });
  },

  registered: (ctx, escrow, station, terms) => {
    generation++;
    rememberStation(ctx.net.id, ctx.host, escrow, station);
    const { key, view } = get();
    if (key !== hostViewKey(ctx.net, ctx.host) || !view) return;
    set({ view: afterRegister(view, ctx.net, ctx.registry, escrow, station, terms), loading: false });
  },

  paidOut: (ctx, escrow, token) => {
    generation++;
    const { key, view } = get();
    if (key !== hostViewKey(ctx.net, ctx.host) || !view) return;
    set({ view: afterPayout(view, escrow, token), loading: false });
  },

  releaseAll: async (ctx, sessions, sign, checkFee) => {
    if (get().batch?.running) return null;
    return releaseMany(
      sessions,
      async (s) => {
        const done = await releaseSession(ctx.server, ctx.net, s, sign, checkFee);
        get().settled(ctx, s, "deadline", done);
        return done;
      },
      (batch) => set({ batch }),
    );
  },

  clearBatch: () => {
    if (!get().batch?.running) set({ batch: null });
  },
}));

/** Before signing: the account pays `fee` (stroops) from its spendable XLM, or EscrowError("balance"). */
export function xlmFeeCheck(net: NetworkConfig, account: string): FeeCheck {
  return async (fee) => {
    const a = await fetchAccountSummary(net, account);
    if (!a.funded) throw new EscrowError("not_funded");
    if (compareAmounts(a.spendableXlm, fromStroops(fee)) < 0) throw new EscrowError("balance");
  };
}
