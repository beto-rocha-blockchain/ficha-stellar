/**
 * Comprovante (contract §3): /r?v=1&m=&n=&h=&a=&k=&f=&p=&u=&wh=&x=&vd=&c=&t=
 * Public route (works while locked or without a wallet). The QR is the
 * station's unsigned statement: it is cross-checked against the user's own
 * on-chain payment (memo + host + amount) and kept in IndexedDB. When the
 * user's payments are only part of the amount, every wallet's payments to the
 * host with the memo are added up (a session paid by several wallets).
 * A custody receipt (v=2, §7.6) is checked against the user's own deposit
 * and claims the unused time back (src/components/CustodyReceipt.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, Loader2, ScanLine, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustodyReceipt } from "@/components/CustodyReceipt";
import { PageHeader } from "@/components/PageHeader";
import { ReceiptFacts } from "@/components/ReceiptFacts";
import { useLang, useT } from "@/i18n";
import { formatMmss as mmss } from "@/pay/format";
import { crossCheckReceipt, fetchMyPayments, fetchReceiptPayments, mayBeShared } from "@/pay/history";
import { ReceiptError, isCustodyReceipt, parseReceipt, unusedSeconds, type Receipt } from "@/pay/receipt";
import { saveReceipt } from "@/pay/receipts-store";
import { parseFichaMemo } from "@/pay/sep7";
import { getRegistry, stationForMemo, useRegistry } from "@/registry";
import { compareAmounts, formatAmount, useNetwork } from "@/stellar";
import { useWallet } from "@/wallet";

export const Route = createFileRoute("/r")({ component: ReceiptScreen });

function ReceiptScreen() {
  const t = useT("pay");
  // Raw query: the router's JSON search parsing would turn "1.500" into 1.5.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const parsed = useMemo(() => {
    try {
      return { receipt: parseReceipt(searchStr) };
    } catch (e) {
      return { field: e instanceof ReceiptError ? e.field : "?" };
    }
  }, [searchStr]);

  return (
    <div className="space-y-4">
      <PageHeader title={t("r.title")} />
      {"receipt" in parsed && parsed.receipt ? (
        isCustodyReceipt(parsed.receipt) ? (
          <CustodyReceipt key={searchStr} receipt={parsed.receipt} />
        ) : (
          <ReceiptView key={searchStr} receipt={parsed.receipt} />
        )
      ) : (
        <>
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            {t("r.invalid", { field: "field" in parsed ? parsed.field : "?" })}
          </div>
          <ScanAgain />
        </>
      )}
    </div>
  );
}

function ScanAgain() {
  const t = useT("pay");
  return (
    <Button asChild variant="outline">
      <Link to="/scan">
        <ScanLine /> {t("scan.again")}
      </Link>
    </Button>
  );
}

type CheckState =
  | { state: "checking" }
  | { state: "confirmed"; uncredited?: string; share?: string; total?: string }
  | { state: "not_confirmed"; reason: string };

function ReceiptView({ receipt: r }: { receipt: Receipt }) {
  const t = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const walletStatus = useWallet((s) => s.status);
  const { registry } = useRegistry();
  const [check, setCheck] = useState<CheckState>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (walletStatus === "loading") return;
    let alive = true;
    const finish = (c: CheckState, persist: boolean) => {
      if (!alive) return;
      setCheck(c);
      if (persist && c.state !== "checking") {
        void saveReceipt({
          receipt: r,
          check: c.state,
          reason: c.state === "not_confirmed" ? c.reason : undefined,
          share: c.state === "confirmed" ? c.share : undefined,
          savedAt: Date.now(),
        });
      }
    };
    setCheck({ state: "checking" });
    if (r.network !== net.id) finish({ state: "not_confirmed", reason: "otherNetwork" }, true);
    else if (!publicKey) finish({ state: "not_confirmed", reason: "noWallet" }, true);
    else {
      fetchMyPayments(net, publicKey)
        .then(async (ps) => {
          let c = crossCheckReceipt(r, ps);
          if (c.check !== "confirmed" && mayBeShared(r, ps)) {
            // Another wallet may have paid part of the session: add up every payment on the ledger.
            const [session, reg] = await Promise.all([fetchReceiptPayments(net, r, ps), getRegistry(net)]);
            const fm = parseFichaMemo(r.memo);
            const st = stationForMemo(reg, fm?.kind === "station" ? fm.stationId : null, r.hostKey);
            c = crossCheckReceipt(r, ps, { payments: session.payments, asset: st?.asset, fichaPrice: st?.ficha_price });
          }
          finish(
            c.check === "confirmed"
              ? { state: "confirmed", uncredited: c.uncredited, share: c.share, total: c.total }
              : { state: "not_confirmed", reason: c.reason ?? "noPayment" },
            true,
          );
        })
        // Offline: keep the receipt but do not claim anything about the payment.
        .catch(() => finish({ state: "not_confirmed", reason: "offline" }, true));
    }
    return () => {
      alive = false;
    };
  }, [r, net, publicKey, walletStatus, attempt]);

  const memo = parseFichaMemo(r.memo);
  const station = r.network === net.id ? stationForMemo(registry, memo?.kind === "station" ? memo.stationId : null, r.hostKey) : undefined;
  const unused = unusedSeconds(r);
  // Several wallets paid the session: the user's own part of the receipt amount.
  const shared =
    check.state === "confirmed" && check.share && check.total && compareAmounts(check.share, check.total) < 0
      ? t("r.share", { share: formatAmount(check.share, lang, 7, 0), total: formatAmount(check.total, lang, 7, 0), code: r.assetCode })
      : null;

  return (
    <>
      {check.state === "checking" && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {t("r.checking")}
        </div>
      )}
      {check.state === "confirmed" && (
        <div className="flex items-start gap-3 rounded-xl border border-success/50 bg-success/10 p-4">
          <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-success" />
          <div>
            <div className="font-display font-semibold">{t("r.confirmed")}</div>
            <p className="text-[12px] text-muted-foreground">{shared ? t("r.confirmedShared") : t("r.confirmedBody")}</p>
            {shared && <p className="mt-1 font-mono text-[12px]">{shared}</p>}
          </div>
        </div>
      )}
      {check.state === "confirmed" && check.uncredited && (
        // Paid after the session ended: the station logged it as orphan, not credited.
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          {t("h.uncredited", { amount: formatAmount(check.uncredited, lang, 7, 0), code: r.assetCode })}
        </div>
      )}
      {check.state === "not_confirmed" && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/60 bg-warning/10 p-4">
          <ShieldQuestion className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-display font-semibold">{t("r.notConfirmed")}</div>
            <p className="text-[12px] text-muted-foreground">{t(`r.reason.${check.reason}`)}</p>
            {check.reason === "offline" && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setAttempt((a) => a + 1)}>
                {tc("retry")}
              </Button>
            )}
          </div>
        </div>
      )}

      <ReceiptFacts receipt={r} title={station?.name ?? r.memo} />

      {r.verdict === "no_current" && <p className="text-[12px] text-destructive">{t("r.verdictNoCurrentHint")}</p>}
      {r.verdict !== "no_current" && unused > 0 && <p className="text-[12px] text-muted-foreground">{t("r.unused", { min: mmss(unused) })}</p>}
      <p className="text-[11px] text-muted-foreground/80">
        {t("r.statement")} {check.state !== "checking" && `· ${t("r.saved")}`}
      </p>
      <div className="flex flex-wrap gap-2">
        {publicKey && (
          <Button asChild variant="outline">
            <Link to="/history">{t("pay.history")}</Link>
          </Button>
        )}
        {station && (
          <Button asChild variant="ghost">
            <Link to="/stations/$id" params={{ id: station.id }}>
              {station.name}
            </Link>
          </Button>
        )}
      </div>
    </>
  );
}
