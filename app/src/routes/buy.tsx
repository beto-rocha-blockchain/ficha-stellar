/**
 * Comprar saldo com PIX: SEP-10 + SEP-24 interactive deposit with the
 * network's anchorDomain (config.ts). The anchor sends the saldo (USDC or
 * XLM) straight to the user's own account; Ficha never holds it.
 * Testnet: the Stellar test anchor simulates the deposit. Public: no
 * anchor yet, the button stays disabled.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Loader2, Plus, ShoppingCart, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { explorerUrl } from "@/config";
import { useAccountSummary } from "@/hooks/useAccountSummary";
import { ActivateTestnet } from "@/components/ActivateTestnet";
import { useLang, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { balanceOf, buildTrustlineTx, describeStellarError, formatAmount, submitTx, useNetwork } from "@/stellar";
import { signTransaction, useWallet } from "@/wallet";
import {
  AnchorError,
  FINAL_STATUSES,
  authenticate,
  fetchDepositTx,
  isDepositGone,
  jwtExpired,
  resolveAnchor,
  startDeposit,
  type Anchor,
  type AnchorCurrency,
  type DepositTx,
} from "@/buy/anchor";
import { loadBuySession, saveBuySession, type BuySession } from "@/buy/session";

export const Route = createFileRoute("/buy")({ component: Buy });

const POLL_MS = 5_000;

function Buy() {
  const t = useT("buy");
  const net = useNetwork();
  const hasAnchor = net.anchorDomain !== null;

  return (
    <div className="space-y-4">
      <PageHeader label={t("label")} title={t("title")} />

      <div
        className={cn(
          "flex items-start gap-2 rounded-md border px-2.5 py-1.5",
          hasAnchor ? "border-warning/40 bg-warning/10" : "border-border bg-card",
        )}
      >
        <Info className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", hasAnchor ? "text-warning" : "text-primary")} />
        <p className="text-[11px] text-muted-foreground">{hasAnchor ? t("testnetNote") : t("publicNote")}</p>
      </div>

      {hasAnchor ? (
        <BuyFlow key={net.id} />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
          <Button className="mt-3 w-full" disabled>
            <ShoppingCart /> {t("cta")}
          </Button>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("custody")}</p>
    </div>
  );
}

function BuyFlow() {
  const t = useT("buy");
  const { lang } = useLang();
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const { data, refresh } = useAccountSummary();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [anchorErr, setAnchorErr] = useState<string | null>(null);
  const [asset, setAsset] = useState<AnchorCurrency | null>(null);
  const [busy, setBusy] = useState<"trust" | "start" | null>(null);
  // The deposit being followed survives the lock screen (which unmounts this
  // page): see src/buy/session.ts.
  const [session, setSessionState] = useState<BuySession | null>(() => (publicKey ? loadBuySession(net.id, publicKey) : null));
  const setSession = (s: BuySession | null) => {
    if (publicKey) saveBuySession(net.id, publicKey, s);
    setSessionState(s);
  };
  const [status, setStatus] = useState<DepositTx | null>(null);

  const load = useCallback(async () => {
    setAnchorErr(null);
    try {
      const a = await resolveAnchor(net);
      setAnchor(a);
      setAsset((cur) => cur ?? a.assets[0] ?? null);
    } catch (e) {
      setAnchorErr(errorText(e, t));
    }
  }, [net, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the anchor until the deposit reaches a final status.
  const done = status !== null && FINAL_STATUSES.has(status.status);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!session || !anchor || done) return;
    let stop = false;
    // The anchor refuses the session (its JWT expired) or lost the deposit:
    // every later poll would fail too, behind a spinner. Drop it and say so.
    const gone = () => {
      stop = true;
      setSession(null);
      setStatus(null);
      toast.error(t("err.gone"));
      void refreshRef.current();
    };
    const tick = async () => {
      if (stop) return;
      if (jwtExpired(session.jwt)) return gone();
      try {
        const s = await fetchDepositTx(anchor, session.jwt, session.id);
        if (stop) return;
        setStatus(s);
        if (s.status === "completed") void refreshRef.current();
      } catch (e) {
        if (stop || !isDepositGone(e)) return; // transient: try again on the next tick
        gone();
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [session, anchor, done]);

  if (!publicKey) return null;

  if (anchorErr) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive" /> {t("anchorFail")}
        </div>
        <p className="mt-1 break-words text-[12px] text-muted-foreground">{anchorErr}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (!anchor || !data) {
    return <div className="h-32 animate-pulse rounded-xl bg-primary/10" />;
  }
  if (anchor.assets.length === 0) {
    return <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("noAssets")}</p>;
  }
  if (!data.funded) {
    return (
      <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
        <p className="text-sm text-muted-foreground">{t(net.friendbotUrl ? "notFundedTestnet" : "notFunded")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Testnet: activate right here and stay on this page. */}
          <ActivateTestnet onDone={refresh} />
          <Button asChild variant="outline">
            <Link to="/">{t("goHome")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const needsTrust = asset !== null && asset.issuer !== null && balanceOf(data, asset) === null;

  const addTrust = async () => {
    if (!asset?.issuer) return;
    setBusy("trust");
    try {
      await submitTx(net, signTransaction(await buildTrustlineTx({ net, source: publicKey, asset: { code: asset.code, issuer: asset.issuer } })));
      toast.success(t("trustOk", { asset: asset.code }));
      await refresh();
    } catch (e) {
      toast.error(describeStellarError(e));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    if (!asset) return;
    setBusy("start");
    try {
      const jwt = await authenticate(anchor, net, publicKey);
      const { id, url } = await startDeposit(anchor, jwt, { asset, account: publicKey, lang });
      setStatus(null);
      setSession({ jwt, id, url, asset });
    } catch (e) {
      toast.error(errorText(e, t));
    } finally {
      setBusy(null);
    }
  };

  const open = async (url: string) => {
    if (Capacitor.isNativePlatform()) await Browser.open({ url });
    else window.open(url, "_blank", "noopener");
  };

  if (session) {
    return (
      <div className="space-y-3">
        <div className="panel">
          <div className="panel-header">
            <span className="label-op">{t("statusTitle", { asset: session.asset.code })}</span>
          </div>
          <div className="space-y-3 p-3">
            <StatusLine tx={status} />
            {status?.amount_out && (
              <p className="text-sm">
                {t("amountOut", { amount: formatAmount(status.amount_out, lang, 7, 2), asset: session.asset.code })}
              </p>
            )}
            {status?.message && <p className="text-[12px] text-muted-foreground">{status.message}</p>}
            {status?.stellar_transaction_id && (
              <a
                href={explorerUrl(net, "tx", status.stellar_transaction_id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-primary underline-offset-2 hover:underline"
              >
                {t("viewTx")} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
        {!done && (
          <Button className="w-full" onClick={() => void open(session.url)}>
            <ExternalLink /> {t("openForm")}
          </Button>
        )}
        {!done && <p className="text-[11px] text-muted-foreground">{t("openHint")}</p>}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            setSession(null);
            setStatus(null);
          }}
        >
          {done ? t("again") : t("cancelFlow")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <div className="label-op mt-4">{t("assetLabel")}</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {anchor.assets.map((a) => (
            <button
              key={`${a.code}:${a.issuer}`}
              type="button"
              onClick={() => setAsset(a)}
              className={cn(
                "rounded-md border px-3 py-2.5 text-left text-sm transition",
                asset?.code === a.code && asset.issuer === a.issuer
                  ? "border-primary/60 bg-primary/5 shadow-[var(--shadow-glow)]"
                  : "border-border bg-background/40 hover:border-primary/40",
              )}
            >
              <span className="font-mono">{a.code}</span>
              <span className="block text-[11px] text-muted-foreground">
                {t("have", { amount: balanceOf(data, a) === null ? "—" : formatAmount(balanceOf(data, a) ?? "0", lang, 2) })}
              </span>
            </button>
          ))}
        </div>
      </div>

      <RequireUnlocked>
        {needsTrust ? (
          <div className="space-y-2">
            <p className="text-[12px] text-muted-foreground">{t("trustNeeded", { asset: asset?.code ?? "" })}</p>
            <Button variant="outline" className="w-full" onClick={() => void addTrust()} disabled={busy !== null}>
              {busy === "trust" ? <Loader2 className="animate-spin" /> : <Plus />}
              {t("trustAdd", { asset: asset?.code ?? "" })}
            </Button>
          </div>
        ) : (
          <Button className="w-full" onClick={() => void start()} disabled={busy !== null || !asset}>
            {busy === "start" ? <Loader2 className="animate-spin" /> : <ShoppingCart />}
            {t("cta")}
          </Button>
        )}
      </RequireUnlocked>
      <p className="text-[11px] text-muted-foreground">{t("authNote", { domain: anchor.domain })}</p>
    </div>
  );
}

function StatusLine({ tx }: { tx: DepositTx | null }) {
  const t = useT("buy");
  const s = tx?.status ?? "starting";
  const ok = s === "completed";
  const bad = tx !== null && FINAL_STATUSES.has(s) && !ok;
  const known = ["starting", "incomplete", "pending_user_transfer_start", "pending_user_transfer_complete", "pending_anchor", "pending_stellar", "pending_trust", "pending_user", "pending_external", "completed", "refunded", "expired", "error"];
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-success" />
      ) : bad ? (
        <XCircle className="h-4 w-4 text-destructive" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      )}
      <span>{known.includes(s) ? t(`status.${s}`) : t("status.other", { status: s })}</span>
    </div>
  );
}

function errorText(e: unknown, t: (k: string, v?: Record<string, string>) => string): string {
  if (e instanceof AnchorError) {
    if (e.code === "network_mismatch") return t("err.network");
    if (e.code === "no_anchor") return t("publicNote");
    return t("err.anchor", { detail: e.message });
  }
  if (e instanceof Error && e.name === "ChallengeError") return t("err.challenge");
  if (e instanceof Error && e.name === "WalletLockedError") return t("err.locked");
  return describeStellarError(e);
}
