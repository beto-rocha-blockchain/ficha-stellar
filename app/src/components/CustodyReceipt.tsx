/**
 * A custody receipt, v=2 (docs/station-app-contract.md §7.6), on the public
 * /r route: checked against this wallet's own deposit (src/custody/receipt.ts),
 * then "X back to you · Y to the venue" and the claim, signed on the phone
 * once the wallet is unlocked. The claim is simulated first: Expired,
 * BadProof or NoSession show here before anything is signed.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, Undo2 } from "lucide-react";
import { explorerUrl } from "@/config";
import { Button } from "@/components/ui/button";
import { ReceiptFacts } from "@/components/ReceiptFacts";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { useLang, useT } from "@/i18n";
import { formatDeadline, formatTimeOfDay as timeOfDay } from "@/lib/format";
import { fromB64url } from "@/custody/chain";
import { describeEscrowError } from "@/custody/describe";
import { saveDeposit } from "@/custody/deposits-store";
import { EscrowError } from "@/custody/errors";
import { getRpc } from "@/custody/escrow";
import { prepareClaim, sendClaim, type ClaimDone } from "@/custody/pay";
import {
  checkCustodyReceipt,
  claimHref,
  depositAssetCode,
  notConfirmedReason,
  publicReceipt,
  receiptConfirmed,
  type CustodyReceiptCheck,
  type PublicReceipt,
} from "@/custody/receipt";
import type { Receipt } from "@/pay/receipt";
import { saveReceipt } from "@/pay/receipts-store";
import { stationById, useRegistry } from "@/registry";
import { compareAmounts, fetchAccountSummary, formatAmount, fromStroops, useNetwork } from "@/stellar";
import { signTransaction, useWallet } from "@/wallet";

type State = { state: "checking" } | { state: "error"; error: unknown } | CustodyReceiptCheck;

export function CustodyReceipt({ receipt: r }: { receipt: Receipt }) {
  const t = useT("custody");
  const tp = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const walletStatus = useWallet((s) => s.status);
  const { registry, status: regStatus } = useRegistry();
  const [check, setCheck] = useState<State>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<unknown>(null);
  const [claimed, setClaimed] = useState<ClaimDone | null>(null);
  const navigate = useNavigate();
  const money = (stroops: bigint | string | undefined) => formatAmount(fromStroops(BigInt(stroops ?? 0)), lang, 7, 0);
  // The deposit's asset once the deposit is known: that is what the contract moves, whatever k says.
  const code = check.state === "checking" || check.state === "error" ? r.assetCode : depositAssetCode(check, r);

  useEffect(() => {
    if (walletStatus === "loading" || regStatus === "loading" || regStatus === "idle") return;
    let alive = true;
    setCheck({ state: "checking" });
    const done = (c: CustodyReceiptCheck) => {
      if (!alive) return;
      setCheck(c);
      // "Conferido na blockchain": this wallet's deposit exists, a, f and k match it, the proof leads to its
      // anchor, and it proves something (q > 0), with no better receipt read before for the session.
      const confirmed = receiptConfirmed(c);
      void saveReceipt({ receipt: r, check: confirmed ? "confirmed" : "not_confirmed", reason: confirmed ? undefined : notConfirmedReason(c), savedAt: Date.now() });
    };
    if (r.network !== net.id) done({ state: "not_mine", reason: "otherNetwork" });
    else if (!net.custody) done({ state: "not_mine", reason: "noCustody" });
    else {
      checkCustodyReceipt(getRpc(net.custody), net, r, publicKey, registry)
        .then(done)
        .catch((error: unknown) => alive && setCheck({ state: "error", error }));
    }
    return () => {
      alive = false;
    };
  }, [r, net, publicKey, walletStatus, registry, regStatus, attempt]);

  const st = r.network === net.id ? stationById(registry, r.memo.split(".")[0]) : undefined;

  const claim = async () => {
    if (check.state !== "open" || !r.refund || !publicKey || claiming) return;
    setClaiming(true);
    setClaimError(null);
    try {
      const server = getRpc(net.custody!);
      const refund = { units: r.refund.units, proof: fromB64url(r.refund.proof) };
      // Simulated first: Expired, BadProof or NoSession throw here, before anything is signed.
      const p = await prepareClaim(server, net, check.record, refund);
      const account = await fetchAccountSummary(net, publicKey);
      if (compareAmounts(account.spendableXlm, fromStroops(p.fee)) < 0) throw new EscrowError("balance");
      const done = await sendClaim(server, check.record, p, refund, signTransaction);
      await saveDeposit(done.record);
      setClaimed(done);
    } catch (e) {
      setClaimError(e);
      // Settled or past its deadline meanwhile: read it again.
      if (e instanceof EscrowError && (e.code === "NoSession" || e.code === "Expired")) setAttempt((a) => a + 1);
    } finally {
      setClaiming(false);
    }
  };

  return (
    <>
      {check.state === "checking" && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {t("r.checking")}
        </div>
      )}
      {check.state === "error" && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/60 bg-warning/10 p-4">
          <ShieldQuestion className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-display font-semibold">{tp("r.notConfirmed")}</div>
            <p className="text-[12px] text-muted-foreground">{describeEscrowError(check.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setAttempt((a) => a + 1)}>
              {tc("retry")}
            </Button>
          </div>
        </div>
      )}
      {check.state === "not_mine" && (check.reason === "noWallet" || check.reason === "noDeposit") && <PublicCheck receipt={r} />}
      {check.state === "not_mine" && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/60 bg-warning/10 p-4">
          <ShieldQuestion className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-display font-semibold">{tp("r.notConfirmed")}</div>
            <p className="text-[12px] text-muted-foreground">
              {check.reason === "noWallet" || check.reason === "otherNetwork" ? tp(`r.reason.${check.reason}`) : t(`r.reason.${check.reason}`)}
            </p>
          </div>
        </div>
      )}
      {check.state === "bad_proof" && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border-2 border-destructive bg-destructive/10 p-4">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-destructive" />
          <p className="text-sm font-medium">{t("r.badProof")}</p>
        </div>
      )}
      {check.state === "superseded" && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border-2 border-warning bg-warning/10 p-4">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("r.superseded", { q: check.best.refund?.units ?? 0 })}</p>
            {claimHref(check.record) && (
              <Button size="sm" variant="outline" onClick={() => void navigate({ href: claimHref(check.record)! })}>
                <Undo2 /> {t("r.openBest")}
              </Button>
            )}
          </div>
        </div>
      )}
      {(check.state === "open" || check.state === "expired" || check.state === "settled") && check.facts.provesNothing && (
        // q = 0: the proof is the public anchor. The receipt may well be right, but it proves nothing.
        <div className="flex items-start gap-3 rounded-xl border border-warning/60 bg-warning/10 p-4">
          <ShieldQuestion className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-display font-semibold">{tp("r.notConfirmed")}</div>
            <p className="text-[12px] text-muted-foreground">{t("r.zeroProof")}</p>
          </div>
        </div>
      )}
      {(check.state === "open" || check.state === "expired" || check.state === "settled") &&
        !check.facts.provesNothing &&
        (check.facts.matches ? (
          <div className="flex items-start gap-3 rounded-xl border border-success/50 bg-success/10 p-4">
            <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-success" />
            <div>
              <div className="font-display font-semibold">{tp("r.confirmed")}</div>
              <p className="text-[12px] text-muted-foreground">{t("r.confirmedBody")}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-warning/60 bg-warning/10 p-4">
            <ShieldQuestion className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
            <div className="min-w-0">
              <div className="font-display font-semibold">{tp("r.notConfirmed")}</div>
              <p className="text-[12px] text-muted-foreground">
                {t("r.reason.amountDiffers", {
                  amount: money(check.record.amount),
                  code: check.record.asset.code,
                  fichas: check.record.fichas === 1 ? tc("ficha") : tc("fichas", { n: check.record.fichas }),
                })}
              </p>
            </div>
          </div>
        ))}

      {(check.state === "open" || check.state === "bad_proof") && !check.facts.unitsOk && (
        // The proof is the only one the station gave: the claim still uses it (contract §7.6 step 3).
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {t("r.unitsDiffer", { expected: check.facts.expectedUnits, q: check.facts.units, unit: check.record.terms.unitSecs })}
        </div>
      )}

      {check.state === "open" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          {claimed ? (
            <div className="space-y-2 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
              <div className="font-display text-lg font-semibold">{t("r.claimed", { amount: money(claimed.toPayer), code })}</div>
              <p className="text-[12px] text-muted-foreground">{t("r.split", { back: money(claimed.toPayer), host: money(claimed.toHost), code })}</p>
              <Button asChild variant="ghost" size="sm">
                <a href={explorerUrl(net, "tx", claimed.hash)} target="_blank" rel="noreferrer">
                  <ExternalLink /> {t("r.viewTx")}
                </a>
              </Button>
            </div>
          ) : check.facts.units === 0 ? (
            <p className="text-sm text-muted-foreground">{t("r.nothingBack")}</p>
          ) : (
            <>
              <div className="flex items-start gap-2">
                <Undo2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-display font-semibold">{t("r.split", { back: money(check.facts.toPayer), host: money(check.facts.toHost), code })}</p>
                  <p className="text-[12px] text-muted-foreground">{t("r.unused", { units: Math.min(check.facts.units, check.facts.paidUnits), unit: check.record.terms.unitSecs })}</p>
                  <p className="flex items-center gap-1 text-[12px] text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" /> {t("r.deadline", { time: formatDeadline(check.record.deadline, lang) })}
                  </p>
                </div>
              </div>
              {claimError != null && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  {describeEscrowError(claimError)}
                </div>
              )}
              <RequireUnlocked>
                <Button
                  size="lg"
                  className="w-full"
                  onClick={claim}
                  disabled={claiming || (claimError instanceof EscrowError && claimError.code === "unknown_outcome")}
                >
                  {claiming ? <Loader2 className="animate-spin" /> : <Undo2 />}
                  {claiming ? t("r.claiming") : t("r.claim", { amount: money(check.facts.toPayer), code })}
                </Button>
              </RequireUnlocked>
            </>
          )}
        </div>
      )}
      {check.state === "expired" && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{t("r.expired", { time: timeOfDay(check.record.deadline, lang) })}</p>
      )}
      {check.state === "settled" && <Settled check={check} code={code} />}

      <ReceiptFacts receipt={r} title={st?.name ?? r.memo} />

      <p className="text-[11px] text-muted-foreground/80">
        {tp("r.statement")} {check.state !== "checking" && check.state !== "error" && `· ${tp("r.saved")}`}
      </p>
      <div className="flex flex-wrap gap-2">
        {publicKey && (
          <Button asChild variant="outline">
            <Link to="/history">{tp("pay.history")}</Link>
          </Button>
        )}
        {st && (
          <Button asChild variant="ghost">
            <Link to="/stations/$id" params={{ id: st.id }}>
              {st.name}
            </Link>
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * The receipt checked in public, for someone who did not pay it (no wallet,
 * or another one): the session its proof names on the contract, open or
 * settled, with the transactions. All read with no key (src/custody/receipt.ts
 * publicReceipt). Shown above the "not checked against your wallet" notice.
 */
function PublicCheck({ receipt: r }: { receipt: Receipt }) {
  const t = useT("custody");
  const { lang } = useLang();
  const net = useNetwork();
  const { registry } = useRegistry();
  const [pub, setPub] = useState<PublicReceipt | null>(null);
  useEffect(() => {
    if (!net.custody) return;
    let alive = true;
    publicReceipt(getRpc(net.custody), net, r, registry)
      .then((p) => alive && setPub(p))
      .catch(() => alive && setPub({ state: "unknown" }));
    return () => {
      alive = false;
    };
  }, [r, net, registry]);
  if (!pub || pub.state === "unknown") return null;
  const money = (x: bigint) => formatAmount(fromStroops(x), lang, 7, 0);
  const code = stationById(registry, r.memo.split(".")[0])?.asset.code ?? r.assetCode;
  const unit = pub.state === "open" ? pub.session.unitSecs : (pub.deposits[0]?.terms.unitSecs ?? 0);
  const q = r.refund?.units ?? 0;
  const ok = pub.amountMatches;
  const tx = pub.state === "settled" ? pub.settle.txHash : undefined;
  const deposit = pub.state !== "open" ? pub.deposits[0]?.txHash : undefined;
  let text: string;
  if (pub.state === "open") {
    text = t("r.public.open", { back: money(pub.toPayer), host: money(pub.toHost), code, units: Math.min(q, pub.paidUnits), unit, time: formatDeadline(pub.session.deadline, lang) });
  } else if (pub.state === "deposited") {
    text = t("r.public.deposited");
  } else {
    const e = pub.settle;
    text =
      e.how === "proof"
        ? t("r.public.proof", { back: money(e.toPayer), host: money(e.toHost), code, units: e.unusedUnits, unit })
        : e.how === "deadline"
          ? t("r.public.deadline", { host: money(e.toHost), code })
          : t("r.public.host", { back: money(e.toPayer), host: money(e.toHost), code });
  }
  return (
    <div className={ok ? "flex items-start gap-3 rounded-xl border border-success/50 bg-success/10 p-4" : "flex items-start gap-3 rounded-xl border border-warning/60 bg-warning/10 p-4"}>
      {ok ? <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-success" /> : <ShieldQuestion className="mt-0.5 h-6 w-6 shrink-0 text-warning" />}
      <div className="min-w-0 space-y-1">
        <div className="font-display font-semibold">{t("r.public.title")}</div>
        <p className="text-[12px] text-muted-foreground">{t("r.public.proofLeads", { q })}</p>
        <p className="text-sm">{text}</p>
        {!ok && <p className="text-[12px] text-warning">{t("r.public.amountDiffers")}</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {tx && (
            <a className="inline-flex items-center gap-1 text-primary underline" href={explorerUrl(net, "tx", tx)} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> {t("r.public.settleTx")}
            </a>
          )}
          {deposit && (
            <a className="inline-flex items-center gap-1 text-primary underline" href={explorerUrl(net, "tx", deposit)} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> {t("r.public.depositTx")}
            </a>
          )}
          <a className="inline-flex items-center gap-1 text-primary underline" href={explorerUrl(net, "contract", pub.escrow)} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" /> {t("r.public.contract")}
          </a>
        </div>
      </div>
    </div>
  );
}

function Settled({ check, code }: { check: Extract<CustodyReceiptCheck, { state: "settled" }>; code: string }) {
  const t = useT("custody");
  const { lang } = useLang();
  const net = useNetwork();
  const s = check.record.settled ?? { how: "unknown" as const };
  const money = (stroops: string | undefined) => formatAmount(fromStroops(BigInt(stroops ?? 0)), lang, 7, 0);
  const text =
    s.how === "proof"
      ? t("r.settledProof", { back: money(s.toPayer), host: money(s.toHost), code })
      : s.how === "deadline"
        ? t("r.settledDeadline")
        : s.how === "host"
          ? t("r.settledHost", { back: money(s.toPayer), code })
          : s.how === "reset"
            ? t("r.settledReset")
            : t("r.settledUnknown");
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <div className="space-y-1">
        <p>{text}</p>
        {s.txHash && (
          <a className="inline-flex items-center gap-1 text-[12px] text-primary underline" href={explorerUrl(net, "tx", s.txHash)} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" /> {t("r.viewTx")}
          </a>
        )}
      </div>
    </div>
  );
}
