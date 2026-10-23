/**
 * Anfitrião (host mode, docs/station-app-contract.md §7.8), testnet only for
 * now: this wallet as a station's host. Its stations on the custody contract
 * and how each stands in the signed registry, their open sessions with each
 * deadline, release (one, or all past their deadline), host_refund, and what
 * the contract holds for it (every claim's host share) with pay_host. Every
 * call is simulated before anything is signed (src/custody/host.ts); the
 * state lives in src/custody/host-store.ts, so a "release all" keeps its
 * progress across the lock screen.
 */
import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Store,
  Undo2,
  Vault,
} from "lucide-react";
import { explorerUrl, type NetworkConfig } from "@/config";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { useAccountSummary } from "@/hooks/useAccountSummary";
import { useHostContext } from "@/hooks/useHostContext";
import { useLang, useT } from "@/i18n";
import { toB64url } from "@/custody/chain";
import { describeHostError } from "@/custody/describe";
import { EscrowError } from "@/custody/errors";
import { ledgerTime, type Rpc, type SettleEvent } from "@/custody/escrow";
import {
  assetOfToken,
  collectOwed,
  ledgerClockNow,
  prepareHostRefund,
  refundPlan,
  refundSplit,
  registryFields,
  releaseSession,
  sendHostCall,
  sessionPhase,
  type HostOwed,
  type LedgerClock,
  type HostSession,
  type HostStation,
} from "@/custody/host";
import { hostViewKey, useHost, xlmFeeCheck, type HostContext } from "@/custody/host-store";
import { formatDateTime, formatTimeOfDay as timeOfDay, shortAddress } from "@/lib/format";
import { formatMmss } from "@/pay/format";
import { useRegistry } from "@/registry";
import { formatAmount, fromStroops, useNetwork } from "@/stellar";
import { signTransaction } from "@/wallet";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/host/")({ component: HostScreen });

/**
 * Now on the ledger's clock, ticking (contract §7.7): the latest close time,
 * read when the screen opens, every minute and when it comes back into view,
 * run forward on the phone's monotonic clock. Deadlines move from open to
 * expired on screen when the contract says so, not when a phone minutes off
 * thinks: release and a partial refund are offered neither early (they would
 * fail with TooEarly) nor late (a full refund only, by mistake).
 */
function useLedgerNow(server: Rpc | undefined, everyMs = 10_000): number {
  const [clock, setClock] = useState<LedgerClock | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!server) return;
    let alive = true;
    const read = () =>
      void ledgerTime(server).then((ledger) => {
        if (alive && ledger !== null) setClock({ ledger, mono: performance.now() });
      });
    read();
    const id = setInterval(read, 60_000);
    const onVisible = () => document.visibilityState === "visible" && read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [server]);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return ledgerClockNow(clock, performance.now(), Date.now() / 1000);
}

/** A session's list key: its ID and its anchor (two sessions may share an ID on the contract). */
function rowKey(s: HostSession): string {
  return `${s.escrow}/${s.station}/${s.session}/${toB64url(s.anchor)}`;
}

function codeOf(token: string, net: NetworkConfig): string {
  return assetOfToken(token, net)?.code ?? "?";
}

function HostScreen() {
  const t = useT("host");
  const tc = useT("common");
  const net = useNetwork();
  const ctx = useHostContext();
  const regStatus = useRegistry().status;
  const key = useHost((s) => s.key);
  const view = useHost((s) => s.view);
  const loading = useHost((s) => s.loading);
  const error = useHost((s) => s.error);
  const load = useHost((s) => s.load);
  const nowSec = useLedgerNow(ctx?.server);
  const ready = regStatus !== "loading" && regStatus !== "idle";

  useEffect(() => {
    if (ctx && ready) void load(ctx);
  }, [ctx, ready, load]);

  if (!net.custody) {
    return (
      <div className="space-y-4">
        <PageHeader label={t("label")} title={t("title")} />
        <Blocked text={t("testnetOnly")} />
      </div>
    );
  }

  const mine = ctx && key === hostViewKey(net, ctx.host) ? view : null;
  const pinned = new Set(mine?.escrows.filter((e) => e.pinned).map((e) => e.id) ?? []);
  const sessionsOf = (st: Pick<HostStation, "escrow" | "id">) => mine?.sessions.filter((s) => s.escrow === st.escrow && s.station === st.id) ?? [];
  // Sessions of a station that has no card (its terms gone from the ledger): listed on their own.
  const orphans = mine?.sessions.filter((s) => !mine.stations.some((st) => st.escrow === s.escrow && st.id === s.station)) ?? [];
  const expired = mine?.sessions.filter((s) => sessionPhase(s, nowSec) === "expired" && !s.archived && pinned.has(s.escrow)) ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        label={`${t("label")} · ${net.label}`}
        title={t("title")}
        actions={
          <Button variant="outline" size="icon" onClick={() => ctx && void load(ctx)} disabled={!ctx || loading} aria-label={tc("refresh")}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        }
      />
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t("intro")}</p>
      {ctx && <WalletLine host={ctx.host} />}

      {error != null && (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" /> {t("loadFailed")}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{describeHostError(error)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => ctx && void load(ctx)}>
            {tc("retry")}
          </Button>
        </div>
      )}

      {!mine && error == null && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" /> {t("loading")}
        </div>
      )}

      {mine && ctx && (
        <>
          {mine.escrows
            .filter((e) => !e.pinned)
            .map((e) => (
              <Blocked key={e.id} text={t("unknownCode", { id: shortAddress(e.id, 6, 6) })} />
            ))}
          {mine.eventsIncomplete && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {t("eventsIncomplete")}
            </p>
          )}

          <ReleaseAll ctx={ctx} expired={expired} />
          {mine.owed.map((o) => (
            <OwedPanel key={`${o.escrow}/${o.token}`} ctx={ctx} owed={o} pinned={pinned.has(o.escrow)} />
          ))}

          {mine.stations.length === 0 && mine.sessions.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>}
          {mine.stations.map((st) => (
            <StationCard key={`${st.escrow}/${st.id}`} ctx={ctx} st={st} sessions={sessionsOf(st)} pinned={pinned.has(st.escrow)} nowSec={nowSec} />
          ))}
          {orphans.length > 0 && (
            <section className="panel">
              <div className="panel-header">
                <span className="label-op">{orphans[0].station}</span>
              </div>
              <ul className="divide-y divide-border/60">
                {orphans.map((s) => (
                  <SessionRow key={rowKey(s)} ctx={ctx} s={s} pinned={pinned.has(s.escrow)} nowSec={nowSec} />
                ))}
              </ul>
            </section>
          )}

          <Button asChild variant="outline" className="w-full">
            <Link to="/host/station" search={{}}>
              <Store /> {t("add")}
            </Link>
          </Button>

          {mine.settled.length > 0 && <SettledList settled={mine.settled} stations={mine.stations} />}
        </>
      )}
    </div>
  );
}

function Blocked({ text }: { text: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border-2 border-destructive bg-destructive/10 p-4">
      <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-destructive" />
      <p className="text-sm font-medium">{text}</p>
    </div>
  );
}

function WalletLine({ host }: { host: string }) {
  const t = useT("host");
  const { lang } = useLang();
  const summary = useAccountSummary();
  const xlm = summary.data?.spendableXlm;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-[12px]">
      <span className="text-muted-foreground">
        {t("wallet")}: <span className="font-mono text-foreground">{shortAddress(host, 6, 6)}</span>
      </span>
      {xlm !== undefined && <span className="font-mono text-muted-foreground">{t("feeBalance", { amount: formatAmount(xlm, lang, 7, 2) })}</span>}
    </div>
  );
}

function StationCard({ ctx, st, sessions, pinned, nowSec }: { ctx: HostContext; st: HostStation; sessions: HostSession[]; pinned: boolean; nowSec: number }) {
  const t = useT("host");
  const tc = useT("common");
  const { lang } = useLang();
  const terms = st.terms;
  const asset = terms ? assetOfToken(terms.token, ctx.net) : null;
  const fields = terms && asset && st.registryState !== "match" && st.registryState !== "not_registered" ? JSON.stringify(registryFields(terms, st.escrow, asset)) : null;
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="label-op">{st.id}</span>
        {terms && (
          <span className={cn("font-mono text-[10px] uppercase tracking-widest", terms.active ? "text-success" : "text-warning")}>
            {terms.active ? t("active") : t("paused")}
          </span>
        )}
      </div>
      <div className="space-y-2 p-3">
        {st.registry && <div className="font-display text-lg font-semibold">{st.registry.name}</div>}
        {terms && (
          <p className="text-[12px] text-muted-foreground">
            {t("terms", {
              price: formatAmount(fromStroops(terms.price), lang, 7, 0),
              code: asset?.code ?? "?",
              min: terms.fichaSecs / 60,
              fichas: terms.maxFichas === 1 ? tc("ficha") : tc("fichas", { n: terms.maxFichas }),
              unit: terms.unitSecs,
              grace: Math.round(terms.graceSecs / 60),
            })}
          </p>
        )}
        {st.archived && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">{t("stationArchived")}</p>}
        <RegistryLine st={st} />
        {fields && (
          <div className="space-y-1.5 rounded-md border border-border bg-background/40 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label-op">{t("reg.fields")}</span>
              <CopyButton value={fields} className="h-7" />
            </div>
            <code className="block break-all font-mono text-[10px] text-muted-foreground">{fields}</code>
          </div>
        )}
        {pinned && (
          <Button asChild variant="outline" size="sm">
            <Link to="/host/station" search={{ id: st.id }}>
              {t("edit")}
            </Link>
          </Button>
        )}
      </div>
      {sessions.length > 0 ? (
        <ul className="divide-y divide-border/60 border-t border-border">
          {sessions.map((s) => (
            <SessionRow key={rowKey(s)} ctx={ctx} s={s} pinned={pinned} nowSec={nowSec} />
          ))}
        </ul>
      ) : (
        terms && <p className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">{t("noSessions")}</p>
      )}
    </section>
  );
}

function RegistryLine({ st }: { st: HostStation }) {
  const t = useT("host");
  const ok = st.registryState === "match";
  const Icon = ok ? ShieldCheck : st.registryState === "differs" ? ShieldAlert : ShieldQuestion;
  return (
    <p className={cn("flex items-start gap-2 text-[12px]", ok ? "text-success" : "text-warning")}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{t(`reg.${st.registryState}`, { fields: st.differs.join(", ") })}</span>
    </p>
  );
}

function leftText(t: (k: string, v?: Record<string, string | number>) => string, secs: number): string {
  const min = Math.max(0, Math.ceil(secs / 60));
  return min < 60 ? t("left.min", { n: min }) : t("left.h", { h: Math.floor(min / 60), m: min % 60 });
}

function SessionRow({ ctx, s, pinned, nowSec }: { ctx: HostContext; s: HostSession; pinned: boolean; nowSec: number }) {
  const t = useT("host");
  const tc = useT("common");
  const { lang } = useLang();
  const batchRunning = useHost((x) => x.batch?.running ?? false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [refunding, setRefunding] = useState(false);
  const phase = sessionPhase(s, nowSec);
  const code = codeOf(s.token, ctx.net);
  const money = (x: bigint) => formatAmount(fromStroops(x), lang, 7, 0);
  const canAct = pinned && !s.archived && !busy && !batchRunning && !(failure instanceof EscrowError && failure.code === "unknown_outcome");

  const release = async () => {
    if (!canAct) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await releaseSession(ctx.server, ctx.net, s, signTransaction, xlmFeeCheck(ctx.net, ctx.host));
      useHost.getState().settled(ctx, s, "deadline", done);
      toast.success(t("released", { id: s.session, amount: money(done.amount ?? s.amount), code }));
    } catch (e) {
      setFailure(e);
      // Someone else settled it meanwhile (anyone may release): read again.
      if (e instanceof EscrowError && e.code === "NoSession") void useHost.getState().load(ctx);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-sm">{s.session}</span>
        <span className="shrink-0 font-mono text-sm tabular">
          {money(s.amount)} {code}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t("s.paid", { fichas: s.fichas === 1 ? tc("ficha") : tc("fichas", { n: s.fichas }), min: (s.fichas * s.fichaSecs) / 60, payer: shortAddress(s.payer) })}
      </div>
      {phase === "open" ? (
        <div className="flex items-center gap-1 text-[11px] text-primary">
          <Clock className="h-3 w-3 shrink-0" /> {t("s.open", { time: timeOfDay(s.deadline, lang), left: leftText(t, s.deadline - nowSec) })}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-[11px] text-warning">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {t("s.expired", { time: timeOfDay(s.deadline, lang) })}
        </div>
      )}
      {s.archived && <p className="text-[11px] text-warning">{t("s.archived")}</p>}
      {failure != null && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          {describeHostError(failure)}
        </div>
      )}
      <RequireUnlocked>
        <div className="flex flex-wrap gap-2 pt-0.5">
          {phase === "expired" && (
            <Button size="sm" onClick={release} disabled={!canAct}>
              {busy ? <Loader2 className="animate-spin" /> : <Vault />}
              {busy ? t("sending") : t("s.release")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setRefunding(true)} disabled={!canAct}>
            <Undo2 /> {phase === "expired" ? t("s.refund") : t("s.refundAll")}
          </Button>
        </div>
      </RequireUnlocked>
      {refunding && <RefundDialog ctx={ctx} s={s} nowSec={nowSec} onClose={() => setRefunding(false)} />}
    </li>
  );
}

/** host_refund, with the rule the contract keeps: until the deadline only in full; after it, any part. */
function RefundDialog({ ctx, s, nowSec, onClose }: { ctx: HostContext; s: HostSession; nowSec: number; onClose: () => void }) {
  const t = useT("host");
  const tc = useT("common");
  const { lang } = useLang();
  const plan = refundPlan(s, nowSec);
  const [units, setUnits] = useState(plan.max);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const u = Math.min(Math.max(units, plan.min), plan.max);
  const split = refundSplit(s, u);
  const code = codeOf(s.token, ctx.net);
  const money = (x: bigint) => formatAmount(fromStroops(x), lang, 7, 0);

  const refund = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // Simulated first: TooEarly or NoSession throw here, before anything is signed.
      const p = await prepareHostRefund(ctx.server, ctx.net, s, u);
      await xlmFeeCheck(ctx.net, ctx.host)(p.fee);
      const done = await sendHostCall(ctx.server, s.escrow, p, signTransaction);
      useHost.getState().settled(ctx, s, "host", done, u);
      toast.success(t("refund.done", { amount: money(done.amount ?? split.toPayer), code }));
      onClose();
    } catch (e) {
      setFailure(e);
      if (e instanceof EscrowError && e.code === "NoSession") void useHost.getState().load(ctx);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("refund.title", { id: s.session })}</DialogTitle>
          <DialogDescription>{plan.fullOnly ? t("refund.ruleBefore", { time: timeOfDay(s.deadline, lang) }) : t("refund.ruleAfter")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {plan.fullOnly && <p className="text-[12px] text-muted-foreground">{t("refund.serving")}</p>}
          <div className="rounded-md border border-border bg-background/40 p-3">
            <p className="text-[12px] text-muted-foreground">
              {t("refund.units", { units: u, paid: plan.paid, unit: s.unitSecs, time: formatMmss(u * s.unitSecs) })}
            </p>
            {!plan.fullOnly && (
              <div className="mt-2 flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setUnits(u - 1)} disabled={busy || u <= plan.min} aria-label="-">
                  <Minus />
                </Button>
                <input
                  type="range"
                  min={plan.min}
                  max={plan.max}
                  value={u}
                  onChange={(e) => setUnits(Number(e.target.value))}
                  disabled={busy}
                  className="flex-1 accent-[var(--color-primary)]"
                  aria-label={t("refund.title", { id: s.session })}
                />
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setUnits(u + 1)} disabled={busy || u >= plan.max} aria-label="+">
                  <Plus />
                </Button>
              </div>
            )}
            <p className="mt-2 font-display text-sm font-semibold">{t("refund.split", { back: money(split.toPayer), host: money(split.toHost), code })}</p>
          </div>
          {failure != null && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              {describeHostError(failure)}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {tc("cancel")}
          </Button>
          <RequireUnlocked>
            <Button onClick={refund} disabled={busy || (failure instanceof EscrowError && failure.code === "unknown_outcome")}>
              {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
              {busy ? t("sending") : t("refund.confirm", { amount: money(split.toPayer), code })}
            </Button>
          </RequireUnlocked>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the contract holds for this host in one asset (every claim's host
 * share, and a release's its account could not take), and pay_host to
 * collect it: simulated first (NothingOwed shows before anything is signed),
 * then signed with this wallet, which pays the fee. Only ever to the host.
 */
function OwedPanel({ ctx, owed, pinned }: { ctx: HostContext; owed: HostOwed; pinned: boolean }) {
  const t = useT("host");
  const { lang } = useLang();
  const batchRunning = useHost((x) => x.batch?.running ?? false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const code = codeOf(owed.token, ctx.net);
  const money = (x: bigint) => formatAmount(fromStroops(x), lang, 7, 0);
  const canAct = pinned && !owed.archived && !busy && !batchRunning && !(failure instanceof EscrowError && failure.code === "unknown_outcome");

  const collect = async () => {
    if (!canAct) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await collectOwed(ctx.server, ctx.net, { escrow: owed.escrow, token: owed.token, host: ctx.host }, signTransaction, xlmFeeCheck(ctx.net, ctx.host));
      useHost.getState().paidOut(ctx, owed.escrow, owed.token);
      toast.success(t("owed.done", { amount: money(done.amount ?? owed.amount), code }));
    } catch (e) {
      setFailure(e);
      // Collected meanwhile (anyone may send pay_host): read again.
      if (e instanceof EscrowError && e.code === "NothingOwed") void useHost.getState().load(ctx);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-xl border border-success/40 bg-success/5 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 font-display font-semibold">
          <Coins className="h-4 w-4 text-success" /> {t("owed.title")}
        </span>
        <span className="font-mono text-sm tabular">
          {money(owed.amount)} {code}
        </span>
      </div>
      <p className="text-[12px] text-muted-foreground">{t("owed.body")}</p>
      {owed.archived && <p className="text-[12px] text-warning">{t("owed.archived")}</p>}
      {failure != null && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          {describeHostError(failure)}
        </div>
      )}
      <RequireUnlocked>
        <Button className="w-full" onClick={() => void collect()} disabled={!canAct}>
          {busy ? <Loader2 className="animate-spin" /> : <Coins />}
          {busy ? t("sending") : t("owed.collect", { amount: money(owed.amount), code })}
        </Button>
      </RequireUnlocked>
    </section>
  );
}

/** Release every session past its deadline, one transaction after another, with the progress kept in the store. */
function ReleaseAll({ ctx, expired }: { ctx: HostContext; expired: HostSession[] }) {
  const t = useT("host");
  const tc = useT("common");
  const { lang } = useLang();
  const batch = useHost((s) => s.batch);
  const [confirming, setConfirming] = useState(false);
  if (expired.length === 0 && !batch) return null;

  // The total per asset (a host may sell in XLM and USDC).
  const totals = new Map<string, bigint>();
  for (const s of expired) {
    const code = codeOf(s.token, ctx.net);
    totals.set(code, (totals.get(code) ?? 0n) + s.amount);
  }
  const totalText = [...totals].map(([code, x]) => `${formatAmount(fromStroops(x), lang, 7, 0)} ${code}`).join(" + ");

  const start = async () => {
    setConfirming(false);
    await useHost.getState().releaseAll(ctx, expired, signTransaction, xlmFeeCheck(ctx.net, ctx.host));
    void useHost.getState().load(ctx);
  };

  return (
    <section className="rounded-xl border border-primary/40 bg-primary/5 p-4">
      {batch ? (
        <div className="space-y-2">
          {batch.running ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> {t("all.progress", { i: Math.min(batch.done + 1, batch.total), n: batch.total })}
              </div>
              <Progress value={(batch.done / Math.max(1, batch.total)) * 100} />
            </>
          ) : (
            <>
              <p className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                {t("all.done", { released: batch.released.length })} {batch.skipped.length > 0 && t("all.skipped", { skipped: batch.skipped.length })}
              </p>
              {batch.stopped != null && (
                <p role="alert" className="flex items-start gap-2 text-[12px] text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {t("all.stopped", { done: batch.done, n: batch.total, reason: describeHostError(batch.stopped) })}
                </p>
              )}
              <Button size="sm" variant="outline" onClick={() => useHost.getState().clearBatch()}>
                {tc("close")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display font-semibold">{t("all.title", { n: expired.length })}</span>
            <span className="font-mono text-sm tabular">{totalText}</span>
          </div>
          <p className="text-[12px] text-muted-foreground">{t("all.body")}</p>
          <RequireUnlocked>
            <Button className="w-full" onClick={() => setConfirming(true)}>
              <Vault /> {t("all.button", { n: expired.length })}
            </Button>
          </RequireUnlocked>
        </div>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{expired.length === 1 ? t("all.confirmTitleOne") : t("all.confirmTitle", { n: expired.length })}</DialogTitle>
            <DialogDescription>{t("all.body")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-[12px]">
            {expired.map((s) => (
              <li key={rowKey(s)} className="flex justify-between gap-3">
                <span>
                  {s.station}.{s.session}
                </span>
                <span className="tabular">
                  {formatAmount(fromStroops(s.amount), lang, 7, 0)} {codeOf(s.token, ctx.net)}
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {tc("cancel")}
            </Button>
            <Button onClick={() => void start()}>
              <Vault /> {t("all.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SettledList({ settled, stations }: { settled: SettleEvent[]; stations: HostStation[] }) {
  const t = useT("host");
  const { lang } = useLang();
  const net = useNetwork();
  const money = (x: bigint) => formatAmount(fromStroops(x), lang, 7, 0);
  const codeFor = (e: SettleEvent) => {
    const st = stations.find((s) => s.id === e.station);
    return st?.terms ? codeOf(st.terms.token, net) : (st?.registry?.asset.code ?? "");
  };
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="label-op">{t("settled.title")}</span>
      </div>
      <ul className="divide-y divide-border/60">
        {settled.slice(0, 10).map((e) => {
          const code = codeFor(e);
          return (
            <li key={`${e.txHash}/${e.session}`} className="space-y-0.5 px-3 py-2 text-[12px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono">
                  {e.station}.{e.session}
                </span>
                <span className="text-[11px] text-muted-foreground">{e.at ? formatDateTime(e.at, lang) : ""}</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground">{t(`settled.${e.how}`, { back: money(e.toPayer), host: money(e.toHost), code })}</span>
                <a href={explorerUrl(net, "tx", e.txHash)} target="_blank" rel="noreferrer" className="shrink-0 text-primary" aria-label={t("viewTx")}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
