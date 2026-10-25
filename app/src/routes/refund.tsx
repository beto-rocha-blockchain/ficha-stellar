/**
 * Devolver (/refund?uri=<SEP-0007 refund URI>): the HOST pays back a refund
 * due that the station screen shows (src/refund/request.ts), signed in the
 * Freighter browser extension (src/refund/freighter.ts). Public route: no
 * Ficha wallet and no PIN, since the host signs with its own account. The
 * network is the URI's, not the app's setting; the station in the memo must
 * be in that network's signed registry, the destination must have paid the
 * host at least the amount under REF (the host's payments on the ledger,
 * read on load and again right before building), Freighter must be on that
 * network with the station's host_key, and the destination is shown in full
 * before signing. An unknown outcome is never sent again from here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, PlugZap, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Undo2 } from "lucide-react";
import { explorerUrl, type NetworkConfig } from "@/config";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useLang, useT } from "@/i18n";
import { formatDateTime, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { HostPayment } from "@/pay/history";
import { getRegistry, type Registry, type Station } from "@/registry";
import { FreighterError, LedgerBlockError, connectFreighter, freighterBlocks, readFreighter, sendRefund, type FreighterSession } from "@/refund/freighter";
import {
  LEDGER_PAGES,
  RefundError,
  checkRefund,
  parseRefundUri,
  readRefundLedger,
  type LedgerCheck,
  type RefundCheck,
  type RefundRequest,
} from "@/refund/request";
import { SubmitError, describeStellarError, formatAmount } from "@/stellar";

export const Route = createFileRoute("/refund")({ component: RefundScreen });

function RefundScreen() {
  const t = useT("refund");
  // Read the raw query: the router's JSON search parsing would mangle the URI.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const uri = new URLSearchParams(searchStr).get("uri") ?? "";
  const parsed = useMemo(() => {
    try {
      return { refund: parseRefundUri(uri) };
    } catch (e) {
      return { error: e instanceof RefundError ? e.code : "not_pay" };
    }
  }, [uri]);

  return (
    <div className="space-y-4">
      <PageHeader label={t("label")} title={t("title")} />
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {"refund" in parsed && parsed.refund ? <RefundView key={uri} r={parsed.refund} /> : <Blocked text={t("badLink", { code: String(parsed.error) })} />}
      <p className="flex items-start gap-2 text-[12px] text-muted-foreground">
        <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("mobileHint")}
      </p>
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

/** The block a registry check gives, with its values. */
function checkBlock(c: Exclude<RefundCheck, { state: "ok" }>, r: RefundRequest, lang: "pt-BR" | "en"): { key: string; vars: Record<string, string> } {
  const net = r.net.label;
  switch (c.state) {
    case "no_station":
      return { key: "block.no_station", vars: { ref: r.refText } };
    case "no_registry":
      return { key: "block.no_registry", vars: { net } };
    case "unknown_station":
      return { key: "block.unknown_station", vars: { id: c.stationId, net } };
    case "inactive":
      return { key: "block.inactive", vars: { id: c.station.id } };
    case "custody":
      return { key: "block.custody", vars: { id: c.station.id } };
    case "asset_mismatch":
      return { key: "block.asset_mismatch", vars: { id: c.station.id, code: r.req.asset.code, expected: c.station.asset.code } };
    case "over_cap":
      return { key: "block.over_cap", vars: { amount: formatAmount(r.amount, lang, 7, 0), cap: formatAmount(c.cap, lang, 7, 0), code: r.req.asset.code } };
    default: {
      const unknown: never = c;
      void unknown;
      return { key: "block.no_registry", vars: { net } };
    }
  }
}

function RefundView({ r }: { r: RefundRequest }) {
  const t = useT("refund");
  const tc = useT("common");
  const { lang } = useLang();
  const [registry, setRegistry] = useState<{ state: "loading" } | { state: "done"; registry: Registry | null }>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  // The registry of the refund's network, verified with its pinned key (null when it cannot be).
  useEffect(() => {
    let alive = true;
    setRegistry({ state: "loading" });
    void getRegistry(r.net).then((reg) => {
      if (alive) setRegistry({ state: "done", registry: reg });
    });
    return () => {
      alive = false;
    };
  }, [r.net, attempt]);

  if (registry.state === "loading") {
    return (
      <>
        <RefundFacts r={r} />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {t("checking")}
        </p>
      </>
    );
  }

  const check = checkRefund(r, registry.registry);
  if (check.state !== "ok") {
    const block = checkBlock(check, r, lang);
    return (
      <>
        <Blocked text={t(block.key, block.vars)} />
        {check.state === "no_registry" && (
          <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <RefreshCw /> {tc("retry")}
          </Button>
        )}
        <RefundFacts r={r} stationName={"station" in check ? check.station.name : undefined} />
      </>
    );
  }

  return <LedgerView r={r} station={check.station} />;
}

type LedgerState = { state: "loading" } | { state: "error" } | { state: "done"; check: LedgerCheck };

/** The block a ledger check gives, with its values. */
function ledgerBlock(c: Exclude<LedgerCheck, { state: "ok" }>, r: RefundRequest, station: Station, lang: "pt-BR" | "en", t: (k: string, v?: Record<string, string>) => string): string {
  const code = r.req.asset.code;
  switch (c.state) {
    case "no_payment":
      return [
        t("ledger.no_payment", { ref: r.refText, code }),
        c.complete ? "" : t("ledger.notAll", { n: String(LEDGER_PAGES * 200) }),
        r.ref.kind === "payment" ? t("ledger.dust", { price: formatAmount(station.ficha_price, lang, 7, 0), code }) : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "more_than_paid":
      return t("ledger.more_than_paid", { amount: formatAmount(r.amount, lang, 7, 0), left: formatAmount(c.left, lang, 7, 0), code, ref: r.refText });
    default: {
      const unknown: never = c;
      void unknown;
      return t("ledger.unreadable", { net: r.net.label });
    }
  }
}

/** The payments the ledger check found: amount, date and transaction. */
function PaymentRows({ title, payments, net }: { title: string; payments: HostPayment[]; net: NetworkConfig }) {
  const { lang } = useLang();
  if (payments.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[12px] text-muted-foreground">{title}</div>
      <ul className="space-y-1">
        {payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 font-mono text-[12px]">
            <span className="font-semibold">
              {formatAmount(p.amount, lang, 7, 0)} {p.assetCode}
            </span>
            <span className="text-muted-foreground">{formatDateTime(p.createdAt, lang)}</span>
            <a href={explorerUrl(net, "tx", p.txHash)} target="_blank" rel="noreferrer" className="text-primary underline">
              tx {p.txHash.slice(0, 8)}…
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LedgerFound({ r, paid, refunds }: { r: RefundRequest; paid: HostPayment[]; refunds: HostPayment[] }) {
  const t = useT("refund");
  return (
    <div className="space-y-2">
      <PaymentRows title={t("ledger.paid", { from: shortAddress(r.req.destination, 6, 6), ref: r.refText })} payments={paid} net={r.net} />
      <PaymentRows title={t("ledger.refunds", { memo: r.req.memo })} payments={refunds} net={r.net} />
    </div>
  );
}

/** The refund against the host's payments on the ledger (src/refund/request.ts checkLedger): only "ok" reaches the sign button. */
function LedgerView({ r, station }: { r: RefundRequest; station: Station }) {
  const t = useT("refund");
  const tc = useT("common");
  const { lang } = useLang();
  const [ledger, setLedger] = useState<LedgerState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLedger({ state: "loading" });
    readRefundLedger(r, station).then(
      (check) => {
        if (alive) setLedger({ state: "done", check });
      },
      () => {
        if (alive) setLedger({ state: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [r, station, attempt]);

  if (ledger.state === "loading") {
    return (
      <>
        <RefundFacts r={r} stationName={station.name} />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {t("checkingLedger")}
        </p>
      </>
    );
  }

  if (ledger.state === "error") {
    return (
      <>
        <Blocked text={t("ledger.unreadable", { net: r.net.label })} />
        <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
          <RefreshCw /> {tc("retry")}
        </Button>
        <RefundFacts r={r} stationName={station.name} />
      </>
    );
  }

  const check = ledger.check;
  if (check.state !== "ok") {
    return (
      <>
        <Blocked text={ledgerBlock(check, r, station, lang, t)} />
        <RefundFacts r={r} stationName={station.name} />
        {check.state !== "no_payment" && <LedgerFound r={r} paid={check.paid} refunds={check.refunds} />}
      </>
    );
  }

  return (
    <>
      <RefundFacts r={r} stationName={station.name} />
      <div className="space-y-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
        <p className="flex items-start gap-2 text-[12px] font-medium">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          {t("ledger.ok", { left: formatAmount(check.left, lang, 7, 0), code: r.req.asset.code })}
        </p>
        <LedgerFound r={r} paid={check.paid} refunds={check.refunds} />
      </div>
      <SignRefund r={r} station={station} onBlocked={(check) => setLedger({ state: "done", check })} />
    </>
  );
}

function NetBadge({ net }: { net: NetworkConfig }) {
  const t = useT("refund");
  const real = net.id === "public";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[11px] font-semibold uppercase tracking-widest",
        real ? "border-destructive/60 bg-destructive/10 text-destructive" : "border-brand-lime/40 bg-brand-lime/10 text-brand-lime",
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(real ? "net.public" : "net.testnet")}
    </span>
  );
}

/** The whole address, its first and last 6 characters set apart: what the host compares with the station screen. */
function FullAddress({ address }: { address: string }) {
  return (
    <span className="break-all font-mono text-sm leading-relaxed">
      <strong className="text-base text-primary">{address.slice(0, 6)}</strong>
      <span className="text-muted-foreground">{address.slice(6, -6)}</span>
      <strong className="text-base text-primary">{address.slice(-6)}</strong>
    </span>
  );
}

function RefundFacts({ r, stationName }: { r: RefundRequest; stationName?: string }) {
  const t = useT("refund");
  const { lang } = useLang();
  const asset = r.req.asset;
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="label-op">{t("amount")}</span>
        <NetBadge net={r.net} />
      </div>
      <div className="space-y-4 p-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="kpi-num text-4xl">{formatAmount(r.amount, lang, 7, 0)}</span>
            <span className="font-mono text-xl font-semibold">{asset.code}</span>
          </div>
          {asset.issuer && <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{asset.issuer}</div>}
        </div>
        <div className="space-y-1">
          <div className="label-op">{t("to")}</div>
          <FullAddress address={r.req.destination} />
          <p className="flex items-start gap-2 pt-1 text-[12px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> {t("compare")}
          </p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t("memo")}</dt>
          <dd className="break-all font-mono">{r.req.memo}</dd>
          <dt className="text-muted-foreground">{t("station")}</dt>
          <dd>
            {stationName ?? "—"} {r.ref.stationId && <span className="font-mono text-[11px] text-muted-foreground">{r.ref.stationId}</span>}
          </dd>
          <dt className="text-muted-foreground">{t("network")}</dt>
          <dd className="font-mono">{r.net.label}</dd>
        </dl>
        <p className="text-[11px] text-muted-foreground">{t("netNote", { net: r.net.label })}</p>
      </div>
    </div>
  );
}

type Conn = { state: "idle" } | { state: "connecting" } | { state: "error"; text: string } | { state: "connected"; session: FreighterSession };

type Send =
  | { state: "idle" }
  | { state: "signing" }
  | { state: "sending" }
  | { state: "done"; hash: string }
  /** No answer from the network: it MAY have landed. Never sent again from this page. */
  | { state: "unknown" }
  | { state: "error"; text: string };

function freighterText(e: unknown, t: (k: string, v?: Record<string, string>) => string): string {
  if (e instanceof FreighterError) {
    if (e.code === "not_installed") return t("notInstalled");
    if (e.code === "bad_signature") return t("badSignature", { message: e.message });
    return t("refused", { message: e.message });
  }
  return describeStellarError(e);
}

function SignRefund({ r, station, onBlocked }: { r: RefundRequest; station: Station; onBlocked: (c: Exclude<LedgerCheck, { state: "ok" }>) => void }) {
  const t = useT("refund");
  const { lang } = useLang();
  const hostKey = station.host_key;
  const [conn, setConn] = useState<Conn>({ state: "idle" });
  const [send, setSend] = useState<Send>({ state: "idle" });
  // One send at a time, even on a double click before the button re-renders disabled.
  const sending = useRef(false);

  const connect = async () => {
    setConn({ state: "connecting" });
    try {
      setConn({ state: "connected", session: await connectFreighter() });
    } catch (e) {
      setConn({ state: "error", text: freighterText(e, t) });
    }
  };

  const amount = formatAmount(r.amount, lang, 7, 0);
  const code = r.req.asset.code;

  const refund = async () => {
    if (sending.current) return;
    sending.current = true;
    setSend({ state: "signing" });
    try {
      // The host may have switched account or network in Freighter since connecting.
      const now = await readFreighter();
      if (freighterBlocks(now, r.net, hostKey).length > 0) {
        setConn({ state: "connected", session: now });
        setSend({ state: "idle" });
        sending.current = false;
        return;
      }
      const res = await sendRefund(r, station, () => setSend({ state: "sending" }));
      setSend({ state: "done", hash: res.hash });
    } catch (e) {
      if (e instanceof SubmitError && e.kind === "unknown") setSend({ state: "unknown" });
      // The ledger, read again right before building, no longer allows it: nothing was signed.
      else if (e instanceof LedgerBlockError) onBlocked(e.check);
      else {
        // Rejected by the network or by Freighter: nothing happened, the host may try again.
        setSend({ state: "error", text: freighterText(e, t) });
        sending.current = false;
      }
    }
  };

  if (send.state === "done") {
    return (
      <div className="rounded-xl border border-success/40 bg-success/10 p-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <div className="mt-3 font-display text-xl font-semibold">{t("doneTitle")}</div>
        <div className="mt-1 text-sm text-muted-foreground">{t("doneBody", { amount, code, to: shortAddress(r.req.destination, 6, 6) })}</div>
        <Button asChild variant="ghost" className="mt-3">
          <a href={explorerUrl(r.net, "tx", send.hash)} target="_blank" rel="noreferrer">
            <ExternalLink /> {t("viewTx")}
          </a>
        </Button>
      </div>
    );
  }

  const session = conn.state === "connected" ? conn.session : null;
  const blocks = session ? freighterBlocks(session, r.net, hostKey) : [];
  const ready = session !== null && blocks.length === 0;
  const busy = send.state === "signing" || send.state === "sending";

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-muted-foreground">{t("signer", { key: shortAddress(hostKey, 6, 6) })}</p>

      {conn.state === "error" && <Blocked text={conn.text} />}
      {blocks.map((b) => (
        <Blocked key={b.key} text={t(b.key, b.vars)} />
      ))}
      {ready && session && (
        <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="text-[12px]">{t("connected", { key: shortAddress(session.address, 6, 6), net: r.net.label })}</p>
        </div>
      )}

      {!ready && (
        <Button size="lg" variant={session ? "outline" : "default"} className="w-full" onClick={connect} disabled={conn.state === "connecting" || busy}>
          {conn.state === "connecting" ? <Loader2 className="animate-spin" /> : session ? <RefreshCw /> : <PlugZap />}
          {conn.state === "connecting" ? t("connecting") : session || conn.state === "error" ? t("checkAgain") : t("connect")}
        </Button>
      )}

      {send.state === "error" && <Blocked text={send.text} />}
      {send.state === "unknown" && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border-2 border-warning bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            {t("unknownOutcome")}{" "}
            <a href={explorerUrl(r.net, "account", hostKey)} target="_blank" rel="noreferrer" className="text-primary underline">
              {t("hostHistory")}
            </a>
          </div>
        </div>
      )}

      {ready && (
        <>
          {r.net.id !== "testnet" && (
            // Said again next to the button that spends it.
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] font-medium">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {t("mainnet")}
            </p>
          )}
          <Button size="lg" className="w-full" onClick={refund} disabled={busy || send.state === "unknown"}>
            {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
            {send.state === "signing" ? t("signing") : send.state === "sending" ? t("sending") : t("sign", { amount, code })}
          </Button>
        </>
      )}
    </div>
  );
}
