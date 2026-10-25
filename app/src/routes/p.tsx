/**
 * Pagar, custody mode: a custody station's pay link (/p?v=1&n=&h=&s=&x=&a=,
 * docs/station-app-contract.md §7.3 and §7.4). Before the confirm button is
 * enabled: the link's network, the signed registry (station, host, custody,
 * escrow), the escrow's code and the station's terms on the ledger, the
 * session already open there, and, for a new one, that nobody paid this
 * session before (a stale QR). Deadlines go by the ledger's clock. The
 * deposit is simulated before anything is signed, so OtherPayer,
 * TermsChanged or Expired show as messages; then it is signed on the phone,
 * sent and followed. Kept on the phone: the deposit record
 * (src/custody/deposits-store.ts) and, for the success screen after a lock,
 * the last payment (src/pay/last-payment.ts). A session that is over, with a
 * receipt kept for it, leads back to its claim.
 */
import { Networks } from "@stellar/stellar-sdk";
import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, History, Loader2, Minus, Plus, ScanLine, ShieldAlert, ShieldCheck, Undo2 } from "lucide-react";
import { explorerUrl, type AssetRef } from "@/config";
import { ActivateTestnet } from "@/components/ActivateTestnet";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { useAccountSummary } from "@/hooks/useAccountSummary";
import { useLang, useT } from "@/i18n";
import { toB64url } from "@/custody/chain";
import { checkChain, checkRegistry, planDeposit, sessionOver, staleSession } from "@/custody/check";
import { describeEscrowError } from "@/custody/describe";
import { findDeposits, saveDeposit, type DepositRecord } from "@/custody/deposits-store";
import { EscrowError } from "@/custody/errors";
import { getRpc, ledgerTime, readEscrow, sessionEvents, type EscrowView } from "@/custody/escrow";
import { PayLinkError, parsePayLink, sessionName, type PayLink } from "@/custody/link";
import { prepareDeposit, recheckDeposit, sendDeposit, type DepositRequest } from "@/custody/pay";
import { claimHref, receiptLeadsTo } from "@/custody/receipt";
import { maybeOpen } from "@/custody/sessions";
import { formatDeadline } from "@/lib/format";
import { loadLastPayment, saveLastPayment, type LastPayment } from "@/pay/last-payment";
import { getReceipt, type StoredReceipt } from "@/pay/receipts-store";
import { useRegistry, type CustodyStation } from "@/registry";
import { fetchAccountSummary, formatAmount, fromStroops, paymentFunds, useNetwork } from "@/stellar";
import { signTransaction, useWallet } from "@/wallet";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/p")({ component: CustodyPayScreen });

/**
 * Shown before the simulation gives the real fee, which is checked before
 * signing. Measured: a deposit cost 0.067 XLM on 23 October 2026, then 2.23
 * XLM on testnet on 25 October, after its resource fees surged (contract §7.1).
 */
function feeEstimate(passphrase: string): bigint {
  return passphrase === Networks.TESTNET ? 25_000_000n : 700_000n;
}

/** Errors after which this session cannot be paid from this link as shown: no retry, the page reads it again. */
const FINAL = new Set(["OtherPayer", "TermsChanged", "Expired", "Inactive", "UnknownStation", "BadFichas", "session_changed", "stale_qr"]);

function CustodyPayScreen() {
  const tp = useT("pay");
  const t = useT("custody");
  // Read the raw query: the router's JSON search parsing would mangle values.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const parsed = useMemo(() => {
    try {
      return { link: parsePayLink(searchStr) };
    } catch (e) {
      return { field: e instanceof PayLinkError ? e.field : "?" };
    }
  }, [searchStr]);
  return (
    <div className="space-y-4">
      <PageHeader label={tp("pay.label")} title={tp("pay.title")} />
      {"link" in parsed && parsed.link ? (
        <CustodyPay key={searchStr} link={parsed.link} />
      ) : (
        <>
          <Blocked text={t("p.badLink", { field: "field" in parsed ? String(parsed.field) : "?" })} />
          <ScanAgain />
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

function ScanAgain() {
  const tp = useT("pay");
  return (
    <Button asChild variant="outline">
      <Link to="/scan">
        <ScanLine /> {tp("scan.again")}
      </Link>
    </Button>
  );
}

function Spinner({ text }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin text-primary" /> {text}
    </div>
  );
}

function CustodyPay({ link }: { link: PayLink }) {
  const tp = useT("pay");
  const t = useT("custody");
  const net = useNetwork();
  const reg = useRegistry();
  const publicKey = useWallet((s) => s.publicKey);
  const memo = sessionName(link.stationId, link.session);
  // Kept outside the page: after the lock screen the deposit already sent is shown again (this session's: its ID and anchor).
  const [done, setDone] = useState<LastPayment | null>(() => (publicKey ? loadLastPayment(net.id, publicKey, link.hostKey, paidKey(link)) : null));

  if (link.network !== net.id) return <BlockedAndScan text={tp("pay.wrongNetwork")} />;
  if (!net.custody) return <BlockedAndScan text={t("p.noCustody")} />;
  if (reg.status === "loading" || reg.status === "idle") return <Spinner />;

  const rc = checkRegistry(link, reg.registry, net);
  if (done) return <CustodySuccess done={done} asset={rc.state === "ok" ? rc.station.asset : { code: "XLM", issuer: null }} />;
  if (rc.state !== "ok") {
    const text = {
      wrong_network: tp("pay.wrongNetwork"),
      no_custody: t("p.noCustody"),
      no_registry: tp("pay.noRegistry"),
      unknown_station: tp("pay.unknownStation", { id: link.stationId }),
      mismatch: tp("pay.mismatch", { id: link.stationId }),
      not_custody: t("p.notCustody", { id: link.stationId }),
      custody_asset: t("p.notXlm", { id: link.stationId }),
      inactive: tp("pay.inactive", { id: link.stationId }),
    }[rc.state];
    return <BlockedAndScan text={text} memo={memo} />;
  }
  return <CustodyForm link={link} station={rc.station} onDone={setDone} />;
}

/** Where the last payment is kept: the session's name and its anchor (another chain under the same ID is another session). */
function paidKey(link: PayLink): string {
  return `${sessionName(link.stationId, link.session)}/${toB64url(link.anchor)}`;
}

function BlockedAndScan({ text, memo }: { text: string; memo?: string }) {
  return (
    <>
      <Blocked text={text} />
      {memo && <SessionLine memo={memo} />}
      <ScanAgain />
    </>
  );
}

function SessionLine({ memo }: { memo: string }) {
  const tp = useT("pay");
  return (
    <div className="font-mono text-[11px] text-muted-foreground">
      {tp("pay.session")}: <span className="text-foreground">{memo}</span>
    </div>
  );
}

/** The contract read, with the ledger's time (null when the RPC could not say: the simulation decides). */
type Chain = { state: "loading" } | { state: "ok"; view: EscrowView; now: number | null } | { state: "error"; error: unknown };

/** For a new session: whether anyone paid this session (ID and anchor) before (step 4, a stale QR). */
type Used = { state: "loading" } | { state: "ok"; stale: boolean } | { state: "error"; error: unknown };

function CustodyForm({ link, station, onDone }: { link: PayLink; station: CustodyStation; onDone: (d: LastPayment) => void }) {
  const tp = useT("pay");
  const t = useT("custody");
  const tc = useT("common");
  const { lang } = useLang();
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const summary = useAccountSummary();
  const memo = sessionName(link.stationId, link.session);
  const fichasText = (k: number) => (k === 1 ? tc("ficha") : tc("fichas", { n: k }));
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [chain, setChain] = useState<Chain>({ state: "loading" });
  const [used, setUsed] = useState<Used>({ state: "loading" });
  const navigate = useNavigate();
  // This phone's record of the session, an open one of this wallet under the same ID with another
  // anchor, and a receipt kept for the ID; undefined while looking.
  const [local, setLocal] = useState<{ record?: DepositRecord; other?: DepositRecord; receipt?: StoredReceipt } | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setChain({ state: "loading" });
    const server = getRpc(net.custody!);
    // The session is its ID and this QR's anchor: another anchor under the same ID is someone else's.
    Promise.all([readEscrow(server, station.escrow, link.hostKey, link.stationId, { session: link.session, anchor: link.anchor }), ledgerTime(server)])
      .then(([view, now]) => alive && setChain({ state: "ok", view, now }))
      .catch((error: unknown) => alive && setChain({ state: "error", error }));
    return () => {
      alive = false;
    };
  }, [net, station.escrow, link.hostKey, link.stationId, link.session, link.anchor, attempt]);

  // No session open under this ID and anchor: was it paid (and settled) before? Read while the user picks fichas.
  const noSession = chain.state === "ok" && chain.view.session === null;
  useEffect(() => {
    if (!noSession) return;
    let alive = true;
    setUsed({ state: "loading" });
    sessionEvents(getRpc(net.custody!), station.escrow, link.hostKey, link.stationId, link.session)
      .then((events) => alive && setUsed({ state: "ok", stale: staleSession(events, link) }))
      .catch((error: unknown) => alive && setUsed({ state: "error", error }));
    return () => {
      alive = false;
    };
  }, [noSession, net, station.escrow, link, attempt]);

  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    void Promise.all([findDeposits(net.id, publicKey, link.hostKey, link.stationId, link.session), getReceipt(net.id, link.hostKey, memo)]).then(([records, receipt]) => {
      if (!alive) return;
      // A record of another anchor under this ID is another session, not this link's.
      const anchor = toB64url(link.anchor);
      setLocal({ record: records.find((d) => d.anchor === anchor), other: records.find((d) => d.anchor !== anchor && maybeOpen(d)), receipt });
    });
    return () => {
      alive = false;
    };
  }, [net.id, publicKey, link.hostKey, link.stationId, link.session, link.anchor, memo, attempt]);

  if (chain.state === "loading" || local === undefined || !publicKey) return <Spinner text={t("p.checking")} />;
  if (chain.state === "error") {
    return (
      <>
        <Blocked text={t("p.readFailed")} />
        <p className="text-[12px] text-muted-foreground">{describeEscrowError(chain.error)}</p>
        <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
          {tc("retry")}
        </Button>
      </>
    );
  }

  const view = chain.view;
  const cc = checkChain(station, view, net);
  if (cc.state !== "ok") {
    const text = {
      unknown_code: t("p.unknownCode", { id: station.id }),
      not_registered: t("p.notRegistered", { id: station.id }),
      archived: t("err.archived"),
      inactive: t("p.chainInactive", { id: station.id }),
      terms_differ: t("p.termsDiffer", { id: station.id, fields: cc.state === "terms_differ" ? cc.fields.join(", ") : "" }),
    }[cc.state];
    return <BlockedAndScan text={text} memo={memo} />;
  }

  // A station never gives one session ID a second chain: with this wallet's open session under
  // the ID and another anchor, one of the two QRs is not the station's. Nothing new goes in.
  const record = local.record;
  if (!record && local.other) return <BlockedAndScan text={t("p.otherAnchor", { memo })} memo={memo} />;

  // Never into a session this wallet holds a receipt for, or saw settle: the
  // contract would open a new session under the old ID that no station serves.
  // Only a kept receipt for this session counts: its proof leads to the link's anchor (a crafted /r link does not).
  const over = sessionOver({ record, receipt: local.receipt !== undefined && receiptLeadsTo(local.receipt.receipt, link.anchor) }, view, publicKey);
  if (over === "lagging") {
    return (
      <>
        <Blocked text={t("p.lagging")} />
        <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
          {tc("retry")}
        </Button>
      </>
    );
  }
  if (over === "over") {
    // Still open on the contract, with a receipt kept: the refund is claimed from it, not lost.
    const open = view.session !== null && view.session.payer === publicKey;
    const claim = open ? claimHref(record, local.receipt) : null;
    return (
      <>
        <Blocked text={t("p.ended")} />
        <SessionLine memo={memo} />
        {claim && (
          <Button onClick={() => void navigate({ href: claim })}>
            <Undo2 /> {t("p.claimBack")}
          </Button>
        )}
        <ScanAgain />
      </>
    );
  }

  // Deadlines by the ledger's clock: a phone minutes off must not refuse a top-up the contract takes.
  const plan = planDeposit(view.session, publicKey, link, cc.terms, chain.now);
  if (plan.kind === "taken") return <BlockedAndScan text={t("p.taken")} memo={memo} />;
  if (plan.kind === "expired") return <BlockedAndScan text={t("p.expired")} memo={memo} />;
  if (plan.kind === "ended") return <BlockedAndScan text={t("p.closing", { time: formatDeadline(plan.session.deadline, lang) })} memo={memo} />;
  if (plan.kind === "full") return <BlockedAndScan text={t("p.full", { fichas: fichasText(plan.session.maxFichas) })} memo={memo} />;
  if (plan.kind === "new" && used.state === "ok" && used.stale) return <BlockedAndScan text={t("p.stale")} memo={memo} />;
  if (plan.kind === "new" && used.state === "error") {
    return (
      <>
        <Blocked text={t("p.usedFailed")} />
        <p className="text-[12px] text-muted-foreground">{describeEscrowError(used.error)}</p>
        <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
          {tc("retry")}
        </Button>
      </>
    );
  }
  // A new session waits for the check above; a top-up needs none.
  const checkingUse = plan.kind === "new" && used.state === "loading";

  const count = Math.min(Math.max(1, n), plan.max);
  const amount = plan.price * BigInt(count);
  const amountText = fromStroops(amount);
  const code = station.asset.code;
  const minutes = (count * (plan.kind === "topup" ? plan.session.fichaSecs : cc.terms.fichaSecs)) / 60;
  const data = summary.data;
  const funds = data ? paymentFunds(data, station.asset, amountText, feeEstimate(net.passphrase)) : null;
  const finalFailure = failure instanceof EscrowError && FINAL.has(failure.code);

  const pay = async () => {
    if (busy || checkingUse) return;
    setBusy(true);
    setFailure(null);
    try {
      const server = getRpc(net.custody!);
      // The page may have been open for minutes: the session (and a new one's events) read again now.
      const again = await recheckDeposit(server, station.escrow, link, publicKey, plan.kind === "topup" ? "topup" : "new", cc.terms);
      const req: DepositRequest = {
        escrow: station.escrow,
        token: cc.terms.token,
        asset: station.asset,
        payer: publicKey,
        link,
        fichas: count,
        terms: cc.terms,
        open: again.open,
        previous: record,
        ledgerNow: again.ledgerNow,
      };
      // Simulated first: a contract refusal, or a deadline that is not this deposit's, throws here, before anything is signed.
      const p = await prepareDeposit(server, net, req);
      const fresh = await fetchAccountSummary(net, publicKey);
      if (!paymentFunds(fresh, station.asset, fromStroops(p.amount), p.fee).enough) throw new EscrowError("balance");
      const d = await sendDeposit(server, net, req, p, signTransaction);
      await saveDeposit(d.record);
      const sent: LastPayment = {
        hash: d.hash,
        n: count,
        amount: fromStroops(p.amount),
        minutes,
        at: Date.now(),
        extended: plan.kind === "topup",
        deadline: d.deadline,
      };
      saveLastPayment(net.id, publicKey, link.hostKey, paidKey(link), sent);
      void summary.refresh();
      onDone(sent);
    } catch (e) {
      setFailure(e);
      // The session may have changed under us (another payer, a top-up): read it again.
      if (e instanceof EscrowError && FINAL.has(e.code)) setAttempt((a) => a + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <p className="text-[12px]">{t("p.verified")}</p>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="label-op">{tp("pay.station")}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{station.id}</span>
        </div>
        <div className="space-y-1 p-3">
          <div className="font-display text-lg font-semibold">{station.name}</div>
          {station.location?.city && <div className="text-[12px] text-muted-foreground">{[station.location.address, station.location.city].filter(Boolean).join(" · ")}</div>}
          <div className="text-[12px] text-muted-foreground">
            {tp("pay.fichaUnit", { price: formatAmount(fromStroops(plan.price), lang, 7, 0), code, min: station.ficha_minutes })}
          </div>
          <div className="text-[12px] text-muted-foreground">{tp("pay.maxFichas", { fichas: fichasText(cc.terms.maxFichas), min: station.max_session_minutes })}</div>
          <SessionLine memo={memo} />
        </div>
      </div>

      <p className="rounded-md border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">{t("p.custodyNote")}</p>

      {plan.kind === "topup" && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {t("p.topup", { fichas: fichasText(plan.session.fichas), time: formatDeadline(plan.session.deadline, lang), left: fichasText(plan.max) })}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="label-op mb-3">{tp("pay.fichas")}</div>
        <div className="flex items-center justify-between gap-4">
          <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setN(count - 1)} disabled={count <= 1 || busy} aria-label="-">
            <Minus />
          </Button>
          <div className="text-center">
            <div className="kpi-num text-4xl">{count}</div>
            <div className="mt-1 flex items-center justify-center gap-1 text-[12px] text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> {tp("pay.minutes", { n: minutes })}
            </div>
          </div>
          <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setN(count + 1)} disabled={count >= plan.max || busy} aria-label="+">
            <Plus />
          </Button>
        </div>
        <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
          <span className="text-sm text-muted-foreground">{tp("pay.total")}</span>
          <span className="font-mono text-xl font-semibold tabular">
            {formatAmount(amountText, lang, 7, 2)} {code}
          </span>
        </div>
        <div className="mt-1 text-right text-[11px] text-muted-foreground">{t("p.fee", { fee: formatAmount(fromStroops(feeEstimate(net.passphrase)), lang, 7, 2) })}</div>
        {funds?.balance != null && (
          <div className={cn("text-right text-[11px]", funds.coversAmount ? "text-muted-foreground" : "text-destructive")}>
            {tp("pay.balance", { amount: formatAmount(funds.balance, lang, 7, 2), code })}
          </div>
        )}
      </div>

      {data && !data.funded && summary.activating && (
        // A new wallet's activation, started on the PIN screen, has not answered yet (about 3 s).
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {tp("pay.activating")}
        </p>
      )}
      {data && !data.funded && !summary.activating && (
        // Testnet: activate right here and stay on the pay link (Friendbot's test XLM).
        <div className="space-y-2">
          <p className="text-sm text-destructive">{tp(net.friendbotUrl ? "pay.notFundedTestnet" : "pay.notFunded")}</p>
          <ActivateTestnet onDone={summary.refresh} />
        </div>
      )}
      {data?.funded && funds?.balance === null && <p className="text-sm text-destructive">{tp("pay.noTrustline", { code })}</p>}
      {data?.funded && funds?.balance != null && !funds.coversAmount && <p className="text-sm text-destructive">{tp("pay.notEnough", { fichas: fichasText(count) })}</p>}

      {failure != null && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border-2 border-destructive bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div>
            {describeEscrowError(failure)}{" "}
            {failure instanceof EscrowError && failure.code === "unknown_outcome" && (
              <Link to="/history" className="text-primary underline">
                {tp("pay.history")}
              </Link>
            )}
          </div>
        </div>
      )}

      {checkingUse && (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {t("p.usedChecking")}
        </p>
      )}

      <RequireUnlocked>
        <Button
          size="lg"
          className="w-full"
          onClick={pay}
          disabled={busy || checkingUse || !funds?.enough || finalFailure || (failure instanceof EscrowError && failure.code === "unknown_outcome")}
        >
          {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {busy ? t("p.sending") : tp("pay.confirm", { amount: formatAmount(amountText, lang, 7, 0), code })}
        </Button>
      </RequireUnlocked>
    </>
  );
}

function CustodySuccess({ done, asset }: { done: LastPayment; asset: AssetRef }) {
  const tp = useT("pay");
  const t = useT("custody");
  const tc = useT("common");
  const { lang } = useLang();
  const net = useNetwork();
  const fichas = done.n === 1 ? tc("ficha") : tc("fichas", { n: done.n });
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-success/40 bg-success/10 p-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <div className="mt-3 font-display text-xl font-semibold">{tp("pay.doneTitle")}</div>
        <div className="mt-1 text-sm text-muted-foreground">
          {done.minutes !== null && `${fichas} · ${tp(done.extended ? "pay.doneAdded" : "pay.doneBody", { min: done.minutes })} · `}
          {formatAmount(done.amount, lang, 7, 0)} {asset.code}
        </div>
      </div>
      {/* The station counts paid time only while it is verified to be charging the phone (contract §5). */}
      <p className="rounded-md border border-border bg-card px-3 py-2 text-sm">{t("p.timeRule")}</p>
      {done.deadline !== undefined && (
        <p className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          {t("p.deadline", { time: formatDeadline(done.deadline, lang) })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/scan">
            <ScanLine /> {tp("pay.scanReceipt")}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/history">
            <History /> {tp("pay.history")}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <a href={explorerUrl(net, "tx", done.hash)} target="_blank" rel="noreferrer">
            <ExternalLink /> {tp("pay.viewTx")}
          </a>
        </Button>
      </div>
    </div>
  );
}
