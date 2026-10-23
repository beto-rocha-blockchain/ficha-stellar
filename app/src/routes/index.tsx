/** Início: address, activation (Friendbot on testnet), saldo, receive, USDC trustline. */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertTriangle, ArrowDownToLine, Loader2, Plus, QrCode, RefreshCw, ShoppingCart, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { QrCode as Qr } from "@/components/QrCode";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { useAccountSummary } from "@/hooks/useAccountSummary";
import { useLang, useT } from "@/i18n";
import { shortAddress } from "@/lib/format";
import {
  buildTrustlineTx,
  describeStellarError,
  formatAmount,
  fundWithFriendbot,
  subtractAmounts,
  submitTx,
  useNetwork,
} from "@/stellar";
import { signTransaction, useWallet } from "@/wallet";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const t = useT("home");
  const tc = useT("common");
  const { lang } = useLang();
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const { data, loading, error, refresh } = useAccountSummary();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [busy, setBusy] = useState<"friendbot" | "trust" | null>(null);

  if (!publicKey) return null;

  const activate = async () => {
    setBusy("friendbot");
    try {
      await fundWithFriendbot(net, publicKey);
      toast.success(t("friendbotOk"));
      await refresh();
    } catch {
      toast.error(t("friendbotFail"));
    } finally {
      setBusy(null);
    }
  };

  const addUsdc = async () => {
    setBusy("trust");
    try {
      const tx = await buildTrustlineTx({ net, source: publicKey, asset: net.usdc });
      await submitTx(net, signTransaction(tx));
      toast.success(t("addUsdcOk"));
      await refresh();
    } catch (e) {
      toast.error(describeStellarError(e));
    } finally {
      setBusy(null);
    }
  };

  const reserve = data?.funded ? subtractAmounts(data.xlm, data.spendableXlm) : "0";

  return (
    <div className="space-y-4">
      <PageHeader
        label={t("address")}
        title={shortAddress(publicKey, 6, 6)}
        actions={
          <Button variant="outline" size="icon" onClick={() => void refresh()} aria-label={tc("refresh")}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        }
      />

      {net.id === "testnet" && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="text-[11px] text-muted-foreground">{tc("testnetNote")}</p>
        </div>
      )}

      {error != null && !data && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" /> {t("loadFail")}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{describeStellarError(error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
            {tc("retry")}
          </Button>
        </div>
      )}

      {data && !data.funded && (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
          <div className="label-op">{t("notFundedTitle")}</div>
          <p className="mt-2 text-sm text-muted-foreground">{net.friendbotUrl ? t("notFundedTestnet") : t("notFundedPublic")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {net.friendbotUrl && (
              <Button onClick={activate} disabled={busy !== null}>
                {busy === "friendbot" ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {t("friendbot")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setReceiveOpen(true)}>
              <ArrowDownToLine /> {t("receive")}
            </Button>
          </div>
        </div>
      )}

      {data?.funded && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
            <BalanceCell code="XLM" value={formatAmount(data.spendableXlm, lang, 2)} sub={`${formatAmount(data.xlm, lang, 7, 0)} XLM`} />
            <BalanceCell code="USDC" value={data.usdc === null ? "—" : formatAmount(data.usdc, lang, 2)} sub={t("available")} />
          </div>
          {reserve !== "0" && <p className="text-[11px] text-muted-foreground">{t("reserveNote", { amount: formatAmount(reserve, lang, 7, 0) })}</p>}

          {data.usdc === null && (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-sm text-muted-foreground">{t("usdcMissing")}</p>
              <div className="mt-3">
                <RequireUnlocked>
                  <Button variant="outline" onClick={addUsdc} disabled={busy !== null}>
                    {busy === "trust" ? <Loader2 className="animate-spin" /> : <Plus />}
                    {t("addUsdc")}
                  </Button>
                </RequireUnlocked>
              </div>
            </div>
          )}

          {data.others.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <span className="label-op">{t("others")}</span>
              </div>
              <ul className="divide-y divide-border/60">
                {data.others.map((b) => (
                  <li key={`${b.code}:${b.issuer}`} className="flex items-center justify-between px-3 py-2">
                    <span className="font-mono text-[11px]">
                      {b.code} <span className="text-muted-foreground">{b.issuer ? shortAddress(b.issuer) : ""}</span>
                    </span>
                    <span className="font-mono text-[11px]">{formatAmount(b.balance, lang, 7, 0)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {!data && loading && (
        <div className="grid grid-cols-2 gap-2">
          <div className="h-24 animate-pulse rounded-lg bg-primary/10" />
          <div className="h-24 animate-pulse rounded-lg bg-primary/10" />
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <Button asChild className="h-auto flex-col gap-1.5 py-3">
          <Link to="/pay">
            <QrCode className="!size-5" />
            <span className="text-[11px]">{t("pay")}</span>
          </Link>
        </Button>
        <Button variant="outline" className="h-auto flex-col gap-1.5 py-3" onClick={() => setReceiveOpen(true)}>
          <ArrowDownToLine className="!size-5" />
          <span className="text-[11px]">{t("receive")}</span>
        </Button>
        <Button asChild variant="outline" className="h-auto flex-col gap-1.5 py-3">
          <Link to="/buy">
            <ShoppingCart className="!size-5" />
            <span className="text-[11px]">{t("buy")}</span>
          </Link>
        </Button>
      </div>

      <Dialog open={receiveOpen} onOpenChange={setReceiveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("receiveTitle")}</DialogTitle>
            <DialogDescription>{t("receiveBody", { network: net.label })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <Qr value={publicKey} className="max-w-[220px]" />
            <code className="w-full break-all rounded-md border border-border bg-background/60 px-2 py-1.5 text-center font-mono text-[11px]">
              {publicKey}
            </code>
            <CopyButton value={publicKey} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BalanceCell({ code, value, sub }: { code: string; value: string; sub: string }) {
  return (
    <div className="bg-card px-4 py-4">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{code}</div>
      <div className="kpi-num mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">{sub}</div>
    </div>
  );
}
