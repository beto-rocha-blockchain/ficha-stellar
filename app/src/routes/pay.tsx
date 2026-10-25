/**
 * Pagar: pay a station's SEP-0007 QR (/pay?uri=web+stellar:pay?...).
 * Money rules (contract §4): amount = fichas x ficha_price (never free, capped
 * by max_session_minutes / ficha_minutes, less the fichas already paid for
 * the session, by this wallet or another); destination, asset and price
 * checked against the signed registry before the confirm button is enabled.
 * A session whose receipt is kept on this phone is over and is not paid
 * again, and the page shows the payment it already sent when it mounts again
 * (src/pay/last-payment.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  Loader2,
  MapPinned,
  Minus,
  Plus,
  QrCode,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { explorerUrl, type AssetRef } from "@/config";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { useAccountSummary } from "@/hooks/useAccountSummary";
import { ActivateTestnet } from "@/components/ActivateTestnet";
import { useLang, useT } from "@/i18n";
import { checkAgainstRegistry, fichasLeft, fichasPaid } from "@/pay/check";
import { formatTimeOfDay } from "@/lib/format";
import { estimatedEnd } from "@/pay/format";
import { fetchMyPayments, fetchSessionPayments, othersFor, paymentsFor, type HostPayment, type MyPayment } from "@/pay/history";
import { loadLastPayment, saveLastPayment, type LastPayment } from "@/pay/last-payment";
import { getReceipt } from "@/pay/receipts-store";
import { Sep7Error, parseFichaMemo, parseSep7Pay, requestPassphrase, type FichaMemo, type PayRequest } from "@/pay/sep7";
import { maxFichas, useRegistry } from "@/registry";
import {
  SubmitError,
  addAmounts,
  buildPaymentTx,
  describeStellarError,
  formatAmount,
  multiplyAmount,
  paymentFunds,
  submitTx,
  useNetwork,
} from "@/stellar";
import { signTransaction, useWallet } from "@/wallet";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pay")({ component: PayScreen });

function PayScreen() {
  // Read the raw query: the router's JSON search parsing would mangle the URI.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const uri = new URLSearchParams(searchStr).get("uri");
  return uri ? <PayUri key={uri} uri={uri} /> : <PayStart />;
}

function PayStart() {
  const t = useT("pay");
  return (
    <div className="space-y-4">
      <PageHeader label={t("pay.label")} title={t("pay.title")} />
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <QrCode className="mx-auto h-10 w-10 text-primary" />
        <p className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">{t("pay.startBody")}</p>
        <div className="mt-5 flex flex-col items-center gap-2">
          <Button asChild size="lg">
            <Link to="/scan">
              <ScanLine /> {t("pay.scanButton")}
            </Link>
          </Button>
          <Button asChild variant="link" size="sm">
            <Link to="/stations">
              <MapPinned /> {t("pay.findStation")}
            </Link>
          </Button>
        </div>
      </div>
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

function PayUri({ uri }: { uri: string }) {
  const t = useT("pay");
  const net = useNetwork();
  const parsed = useMemo(() => {
    try {
      const req = parseSep7Pay(uri);
      return { req, memo: parseFichaMemo(req.memo) };
    } catch (e) {
      return { error: e instanceof Sep7Error ? e.code : "not_pay" };
    }
  }, [uri]);

  let blocked: string | null = null;
  if ("error" in parsed) blocked = t("pay.badQr", { code: String(parsed.error) });
  else if (!parsed.memo) blocked = t("pay.notFicha");
  // No network_passphrase is a public network request (SEP-0007), not "any network".
  else if (requestPassphrase(parsed.req) !== net.passphrase) blocked = t("pay.wrongNetwork");

  return (
    <div className="space-y-4">
      <PageHeader label={t("pay.label")} title={t("pay.title")} />
      {blocked || "error" in parsed || !parsed.memo ? (
        <>
          <Blocked text={blocked ?? t("pay.notFicha")} />
          <Button asChild variant="outline">
            <Link to="/scan">
              <ScanLine /> {t("scan.again")}
            </Link>
          </Button>
        </>
      ) : (
        <PayForm req={parsed.req} memo={parsed.memo} />
      )}
    </div>
  );
}

/**
 * Earlier payments to the session being paid: this wallet's, and every
 * wallet's as the host key received them (the station counts them all).
 */
type Paid = { state: "loading" } | { state: "ok"; payments: MyPayment[]; session: HostPayment[] } | { state: "error"; error: unknown };

function PayForm({ req, memo }: { req: PayRequest; memo: FichaMemo }) {
  const t = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const fichasText = (k: number) => (k === 1 ? tc("ficha") : tc("fichas", { n: k }));
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const reg = useRegistry();
  const summary = useAccountSummary();
  const [n, setN] = useState(1);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  // Kept outside the page: after the lock screen or Back from History, the
  // payment already sent is shown again, not a Pay form for the same session.
  const [done, setDone] = useState<LastPayment | null>(() => (publicKey ? loadLastPayment(net.id, publicKey, req.destination, req.memo) : null));
  const [paid, setPaid] = useState<Paid>({ state: "loading" });
  const [paidAttempt, setPaidAttempt] = useState(0);

  // What was already paid for this session, by this wallet or another one
  // (someone else's "add fichas" QR, a friend topping up): the station caps
  // the session at max_session_minutes, so it limits the fichas left to buy.
  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    setPaid({ state: "loading" });
    Promise.all([fetchMyPayments(net, publicKey, 1), fetchSessionPayments(net, req.destination, req.memo)])
      .then(([ps, session]) => {
        if (alive) setPaid({ state: "ok", payments: paymentsFor(ps, req.memo, req.destination, req.asset.code), session });
      })
      .catch((error: unknown) => {
        if (alive) setPaid({ state: "error", error });
      });
    return () => {
      alive = false;
    };
  }, [net, publicKey, req.memo, req.destination, req.asset.code, paidAttempt]);

  // A receipt kept for this session means the station already closed it: an
  // old QR (browser back, a saved link, a photo) paid again is logged by the
  // station as orphan and delivers nothing. null while looking it up.
  const [ended, setEnded] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    setEnded(null);
    void getReceipt(net.id, req.destination, req.memo).then((r) => {
      if (alive) setEnded(r !== undefined);
    });
    return () => {
      alive = false;
    };
  }, [net.id, req.destination, req.memo]);

  if (done) return <PaySuccess done={done} asset={req.asset} />;

  if (reg.status === "loading" || reg.status === "idle") {
    return (
      <div className="grid place-items-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const check = checkAgainstRegistry(req, memo, reg.registry, net);
  const station = check.state === "ok" || check.state === "legacy" ? check.station : null;

  let blockedText: string | null = null;
  if (check.state === "wrong_network") blockedText = t("pay.wrongNetwork");
  if (check.state === "mismatch") blockedText = t("pay.mismatch", { id: check.stationId });
  if (check.state === "asset_mismatch") blockedText = t("pay.assetMismatch", { id: check.station.id, code: req.asset.code, expected: check.station.asset.code });
  if (check.state === "price_mismatch") {
    const code = req.asset.code;
    blockedText = t("pay.priceDiffers", { id: check.station.id, qr: `${req.amount} ${code}`, reg: `${check.station.ficha_price} ${code}` });
  }
  if (check.state === "unknown_station") blockedText = t("pay.unknownStation", { id: check.stationId });
  if (check.state === "inactive") blockedText = t("pay.inactive", { id: check.stationId });
  if (check.state === "custody_only") blockedText = t("pay.custodyOnly", { id: check.stationId });
  if (check.state === "no_registry") blockedText = t("pay.noRegistry");
  if (check.state === "no_station_code") blockedText = t("pay.noStationCode");
  // Legacy without a registry match (testnet only): only the QR's own amount, one ficha.
  if (check.state === "legacy" && !station && !req.amount) blockedText = t("pay.notFicha");
  if (!blockedText && ended) blockedText = t("pay.sessionEnded");

  const earlier = paid.state === "ok" ? paid.payments : [];
  const earlierAmount = formatAmount(earlier.reduce((s, p) => addAmounts(s, p.amount), "0"), lang, 7, 0);
  const others = paid.state === "ok" && publicKey ? othersFor(paid.session, publicKey, req.asset) : [];
  const othersAmount = formatAmount(others.reduce((s, p) => addAmounts(s, p.amount), "0"), lang, 7, 0);
  const left = station ? fichasLeft(station, [...earlier, ...others]) : 1;
  if (!blockedText && station && left === 0) {
    blockedText = t("pay.sessionFull", { fichas: fichasText(maxFichas(station)), min: station.max_session_minutes });
  }

  if (blockedText) {
    return (
      <>
        <Blocked text={blockedText} />
        <SessionLine req={req} />
        <Button asChild variant="outline">
          <Link to="/scan">
            <ScanLine /> {t("scan.again")}
          </Link>
        </Button>
      </>
    );
  }

  const price = station ? station.ficha_price : req.amount!;
  const maxN = left;
  const count = Math.min(Math.max(1, n), maxN);
  const fichaMin = station?.ficha_minutes ?? null;
  const amount = multiplyAmount(price, count);
  const needsOverride = check.state === "legacy";

  const data = summary.data;
  // The fee (at most 0.001 XLM) is paid in XLM whatever the asset.
  const funds = data ? paymentFunds(data, req.asset, amount) : null;
  const bal = funds?.balance ?? null;
  const enough = funds?.enough ?? false;

  const pay = async () => {
    if (!publicKey || busy) return;
    setBusy(true);
    setUnknownOutcome(false);
    try {
      const tx = await buildPaymentTx({ net, source: publicKey, destination: req.destination, asset: req.asset, amount, memo: req.memo });
      const res = await submitTx(net, signTransaction(tx));
      const extended = earlier.length > 0 || others.length > 0;
      const sent = { hash: res.hash, n: count, amount, minutes: fichaMin ? fichaMin * count : null, at: Date.now(), extended };
      saveLastPayment(net.id, publicKey, req.destination, req.memo, sent);
      setDone(sent);
      void summary.refresh();
    } catch (e) {
      if (e instanceof SubmitError && e.kind === "unknown") setUnknownOutcome(true);
      else toast.error(describeStellarError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {check.state === "ok" ? (
        <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="text-[12px]">{t("pay.verified")}</p>
        </div>
      ) : (
        <div role="alert" className="space-y-2 rounded-xl border-2 border-warning bg-warning/10 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t("pay.legacy")}</p>
              {station && <p className="text-muted-foreground">{t("pay.legacyKnown", { name: station.name })}</p>}
              {!station && <p className="text-muted-foreground">{t("pay.legacyOneFicha")}</p>}
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--warning)]" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            {t("pay.legacyOverride")}
          </label>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <span className="label-op">{t("pay.station")}</span>
          {station && <span className="font-mono text-[10px] text-muted-foreground">{station.id}</span>}
        </div>
        <div className="space-y-1 p-3">
          <div className="font-display text-lg font-semibold">{station?.name ?? req.msg ?? "—"}</div>
          {station?.location?.city && <div className="text-[12px] text-muted-foreground">{[station.location.address, station.location.city].filter(Boolean).join(" · ")}</div>}
          {fichaMin !== null && (
            <div className="text-[12px] text-muted-foreground">
              {t("pay.fichaUnit", { price: formatAmount(price, lang, 7, 0), code: req.asset.code, min: fichaMin })}
            </div>
          )}
          {station && <div className="text-[12px] text-muted-foreground">{t("pay.maxFichas", { fichas: fichasText(maxFichas(station)), min: station.max_session_minutes })}</div>}
          <SessionLine req={req} />
        </div>
      </div>

      {earlier.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {station
            ? t("pay.alreadyPaid", { amount: earlierAmount, code: req.asset.code, n: fichasPaid(earlier, station.ficha_price), max: maxFichas(station), left })
            : t("pay.alreadyPaidLegacy", { amount: earlierAmount, code: req.asset.code })}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {station
            ? t("pay.othersPaid", { amount: othersAmount, code: req.asset.code, fichas: fichasText(fichasPaid(others, station.ficha_price)), left })
            : t("pay.othersPaidLegacy", { amount: othersAmount, code: req.asset.code })}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="label-op mb-3">{t("pay.fichas")}</div>
        <div className="flex items-center justify-between gap-4">
          <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setN(count - 1)} disabled={count <= 1 || busy} aria-label="-">
            <Minus />
          </Button>
          <div className="text-center">
            <div className="kpi-num text-4xl">{count}</div>
            {fichaMin !== null && (
              <div className="mt-1 flex items-center justify-center gap-1 text-[12px] text-muted-foreground">
                <Clock className="h-3.5 w-3.5" /> {t("pay.minutes", { n: fichaMin * count })}
              </div>
            )}
          </div>
          <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setN(count + 1)} disabled={count >= maxN || busy} aria-label="+">
            <Plus />
          </Button>
        </div>
        <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
          <span className="text-sm text-muted-foreground">{t("pay.total")}</span>
          <span className="font-mono text-xl font-semibold tabular">
            {formatAmount(amount, lang, 7, 2)} {req.asset.code}
          </span>
        </div>
        {bal !== null && (
          <div className={cn("mt-1 text-right text-[11px]", funds?.coversAmount ? "text-muted-foreground" : "text-destructive")}>
            {t("pay.balance", { amount: formatAmount(bal, lang, 7, 2), code: req.asset.code })}
          </div>
        )}
      </div>

      {!data && summary.error != null && (
        <RetryNotice text={t("pay.accountFailed")} reason={describeStellarError(summary.error)} onRetry={() => void summary.refresh()} />
      )}
      {data && !data.funded && summary.activating && (
        // A new wallet's activation, started on the PIN screen, has not answered yet.
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {t("pay.activating")}
        </p>
      )}
      {data && !data.funded && !summary.activating &&
        (net.friendbotUrl ? (
          // Testnet: activate right here and stay on the pay link.
          <div className="space-y-2">
            <p className="text-sm text-destructive">{t("pay.notFundedTestnet")}</p>
            <ActivateTestnet onDone={summary.refresh} />
          </div>
        ) : (
          <HomeHint text={t("pay.notFunded")} />
        ))}
      {data?.funded && bal === null && <HomeHint text={t("pay.noTrustline", { code: req.asset.code })} />}
      {data?.funded && bal !== null && !funds?.coversAmount && <p className="text-sm text-destructive">{t("pay.notEnough", { fichas: fichasText(count) })}</p>}
      {data?.funded && funds?.feeShort && <HomeHint text={t("pay.feeXlm", { code: req.asset.code })} />}
      {unknownOutcome && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border-2 border-warning bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            {t("pay.unknownOutcome")}{" "}
            <Link to="/history" className="text-primary underline">
              {t("pay.history")}
            </Link>
          </div>
        </div>
      )}

      {paid.state === "loading" && publicKey && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("pay.checkingPaid")}
        </div>
      )}
      {paid.state === "error" && (
        <RetryNotice text={t("pay.paidCheckFailed")} reason={describeStellarError(paid.error)} onRetry={() => setPaidAttempt((a) => a + 1)} />
      )}

      {net.id !== "testnet" && (
        // Said again next to the button that spends it.
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] font-medium">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {t("pay.mainnet")}
        </p>
      )}
      <RequireUnlocked>
        <Button
          size="lg"
          className="w-full"
          onClick={pay}
          disabled={busy || !enough || (needsOverride && !override) || unknownOutcome || paid.state !== "ok" || ended !== false}
        >
          {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {busy ? t("pay.sending") : t("pay.confirm", { amount: formatAmount(amount, lang, 7, 0), code: req.asset.code })}
        </Button>
      </RequireUnlocked>
    </>
  );
}

function SessionLine({ req }: { req: PayRequest }) {
  const t = useT("pay");
  return (
    <div className="font-mono text-[11px] text-muted-foreground">
      {t("pay.session")}: <span className="text-foreground">{req.memo}</span>
    </div>
  );
}

function RetryNotice({ text, reason, onRetry }: { text: string; reason: string; onRetry: () => void }) {
  const tc = useT("common");
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p>{text}</p>
        <p className="text-muted-foreground">{reason}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {tc("retry")}
      </Button>
    </div>
  );
}

function HomeHint({ text }: { text: string }) {
  const t = useT("pay");
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-[12px]">
      <span>{text}</span>
      <Button asChild size="sm" variant="outline">
        <Link to="/">{t("pay.goHome")}</Link>
      </Button>
    </div>
  );
}

function PaySuccess({ done, asset }: { done: LastPayment; asset: AssetRef }) {
  const t = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const net = useNetwork();
  const end = estimatedEnd(done.at, done.minutes, done.extended);
  const fichas = done.n === 1 ? tc("ficha") : tc("fichas", { n: done.n });
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-success/40 bg-success/10 p-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <div className="mt-3 font-display text-xl font-semibold">{t("pay.doneTitle")}</div>
        <div className="mt-1 text-sm text-muted-foreground">
          {done.minutes !== null && `${fichas} · ${t(done.extended ? "pay.doneAdded" : "pay.doneBody", { min: done.minutes })} · `}
          {formatAmount(done.amount, lang, 7, 0)} {asset.code}
        </div>
        {end && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-sm">
            <Clock className="h-4 w-4 text-primary" />
            {t("pay.estimatedEnd", { time: formatTimeOfDay(end.getTime() / 1000, lang) })}
          </div>
        )}
        {done.minutes !== null && done.extended && <div className="mt-3 text-[12px] text-muted-foreground">{t("pay.endOnStation")}</div>}
      </div>
      {/* The station counts paid time only while it is verified to be charging the phone (contract §5). */}
      <p className="rounded-md border border-border bg-card px-3 py-2 text-sm">{t("pay.timeRule")}</p>
      <p className="text-sm text-muted-foreground">{t("pay.receiptHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/scan">
            <ScanLine /> {t("pay.scanReceipt")}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/history">
            <History /> {t("pay.history")}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <a href={explorerUrl(net, "tx", done.hash)} target="_blank" rel="noreferrer">
            <ExternalLink /> {t("pay.viewTx")}
          </a>
        </Button>
      </div>
    </div>
  );
}
