/** Ajustes: network, language, show words (PIN), lock, remove wallet, more (buy, battery, venues), host mode (testnet), Sobre o Ficha. */
import { useState, type FormEvent, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { BatteryCharging, ChevronRight, Eye, Loader2, Lock, ShieldCheck, ShoppingCart, Store, Trash2, Vault, type LucideIcon } from "lucide-react";
import { BiometricSetting } from "@/components/BiometricSetting";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { RemoveWalletDialog } from "@/components/RemoveWalletDialog";
import { NETWORKS, explorerUrl, type NetworkId } from "@/config";
import { formatWait, shortAddress } from "@/lib/format";
import { useLang, useT, type Lang } from "@/i18n";
import { cn } from "@/lib/utils";
import { useSecureScreen } from "@/native/secure-screen";
import { useUi } from "@/store/ui";
import { PinLockedError, WrongPinError, usePinWait, useWallet } from "@/wallet";

export const Route = createFileRoute("/settings")({ component: Settings });

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="label-op">{title}</span>
      </div>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-2">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "w-full rounded-md border px-3 py-2.5 text-left text-sm transition",
            value === o.v ? "border-primary/60 bg-primary/5 shadow-[var(--shadow-glow)]" : "border-border bg-background/40 hover:border-primary/40",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Settings() {
  const t = useT("settings");
  const { lang, setLang } = useLang();
  const network = useUi((s) => s.network);
  const setNetwork = useUi((s) => s.setNetwork);
  const kind = useWallet((s) => s.kind);
  const lock = useWallet((s) => s.lock);
  const [revealOpen, setRevealOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [mainnetOpen, setMainnetOpen] = useState(false);

  const switchTo = (id: NetworkId) => {
    setNetwork(id);
    toast.success(t("networkChanged", { network: NETWORKS[id].label }));
  };
  const changeNetwork = (id: NetworkId) => {
    if (id === network) return;
    // Real money: confirmed first. Back to the testnet needs no confirmation.
    if (id === "public") setMainnetOpen(true);
    else switchTo(id);
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} />

      <Section title={t("network")}>
        <Segmented<NetworkId>
          value={network}
          onChange={changeNetwork}
          options={[
            { v: "testnet", label: t("networkTestnet") },
            { v: "public", label: t("networkPublic") },
          ]}
        />
        {network === "public" && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-muted-foreground">{t("networkPublicWarn")}</p>
        )}
      </Section>

      <Section title={t("language")}>
        <Segmented<Lang>
          value={lang}
          onChange={setLang}
          options={[
            { v: "pt-BR", label: "Português (Brasil)" },
            { v: "en", label: "English" },
          ]}
        />
      </Section>

      <Section title={t("security")}>
        <Button variant="outline" className="w-full justify-start" onClick={() => setRevealOpen(true)}>
          <Eye /> {kind === "secret" ? t("showSecret") : t("showWords")}
        </Button>
        <Button variant="outline" className="w-full justify-start" onClick={lock}>
          <Lock /> {t("lockNow")}
        </Button>
        <BiometricSetting onEnabledChange={setBiometricOn} />
        <p className="text-[11px] text-muted-foreground">{t(biometricOn ? "autoLock" : "autoLockPin")}</p>
        <Button variant="outline" className="w-full justify-start border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setRemoveOpen(true)}>
          <Trash2 /> {t("remove")}
        </Button>
      </Section>

      <Section title={t("more")}>
        <MoreLink to="/buy" icon={ShoppingCart} label={t("moreBuy")} />
        <MoreLink to="/battery" icon={BatteryCharging} label={t("moreBattery")} />
        <MoreLink to="/estabelecimentos" icon={Store} label={t("moreVenues")} />
      </Section>

      {/* Host mode: only where custody exists, the testnet for now (contract §7). */}
      {NETWORKS[network].custody && (
        <Section title={t("host")}>
          <MoreLink to="/host" icon={Vault} label={t("hostLink")} />
          <p className="text-[11px] text-muted-foreground">{t("hostNote")}</p>
        </Section>
      )}

      <Section title={t("about")}>
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
            <p>{t("aboutBody1")}</p>
            <p>{t("aboutBody2")}</p>
            <p>{t("aboutBody3")}</p>
            <p>{t("aboutBody4")}</p>
          </div>
        </div>
        <AboutFacts network={network} />
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">{t("version", { v: __APP_VERSION__ })}</p>
      </Section>

      <MainnetDialog
        open={mainnetOpen}
        onOpenChange={setMainnetOpen}
        onConfirm={() => {
          setMainnetOpen(false);
          switchTo("public");
        }}
      />
      <RevealDialog open={revealOpen} onOpenChange={setRevealOpen} />
      <RemoveWalletDialog open={removeOpen} onOpenChange={setRemoveOpen} requirePin />
    </div>
  );
}

function MoreLink({ to, icon: Icon, label }: { to: "/buy" | "/battery" | "/estabelecimentos" | "/host"; icon: LucideIcon; label: string }) {
  return (
    <Link
      to={to}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2.5 text-sm transition hover:border-primary/40"
    >
      <Icon className="h-4 w-4 text-primary" />
      <span className="flex-1">{label}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

/** What this build trusts on the active network, so a curious user can check it. */
function AboutFacts({ network }: { network: NetworkId }) {
  const t = useT("settings");
  const net = NETWORKS[network];
  const rows: [string, ReactNode][] = [
    [t("factNetwork"), net.label],
    [t("factHorizon"), new URL(net.horizonUrl).host],
    [
      t("factRegistryKey"),
      net.registryKey ? (
        <a href={explorerUrl(net, "account", net.registryKey)} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
          {shortAddress(net.registryKey, 6, 6)}
        </a>
      ) : (
        t("factNone")
      ),
    ],
    [t("factAnchor"), net.anchorDomain ?? t("factNone")],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-background/40 px-3 py-2 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="truncate text-right font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Before switching to Mainnet: real money, another balance, and the words that guard it. Cancel stays on the testnet. */
function MainnetDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => void }) {
  const t = useT("settings");
  const kind = useWallet((s) => s.kind);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("mainnetTitle")}</DialogTitle>
          <DialogDescription>{t("mainnetMoney")}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>{t("mainnetBalance")}</li>
          <li>{t(kind === "secret" ? "mainnetSecret" : "mainnetWords")}</li>
        </ul>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("mainnetStay")}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t("mainnetConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevealDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT("settings");
  const tw = useT("wallet");
  const tc = useT("common");
  const reveal = useWallet((s) => s.reveal);
  const kind = useWallet((s) => s.kind);
  const [pin, setPin] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wait = usePinWait();
  useSecureScreen(open); // no screenshot or Recents thumbnail of the words

  const close = (o: boolean) => {
    if (!o) {
      setSecret(null);
      setPin("");
      setError(null);
    }
    onOpenChange(o);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      setSecret(await reveal(pin));
    } catch (err) {
      setError(err instanceof WrongPinError ? tw("pin.wrong") : err instanceof PinLockedError ? null : String(err));
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{kind === "secret" ? t("showSecret") : t("showWords")}</DialogTitle>
          <DialogDescription>{t("showWordsBody")}</DialogDescription>
        </DialogHeader>
        {secret ? (
          kind === "mnemonic" ? (
            <ol className="grid grid-cols-3 gap-1.5">
              {secret.split(" ").map((w, i) => (
                <li key={i} className="flex items-baseline gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1.5">
                  <span className="w-4 text-right font-mono text-[9px] text-muted-foreground">{i + 1}</span>
                  <span className="font-mono text-[12px]">{w}</span>
                </li>
              ))}
            </ol>
          ) : (
            <code className="break-all rounded-md border border-border bg-background/60 px-2 py-2 font-mono text-[12px]">{secret}</code>
          )
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Label htmlFor="reveal-pin">{tw("pin.label")}</Label>
            <Input id="reveal-pin" type="password" autoComplete="current-password" autoFocus className="h-11 font-mono tracking-[0.3em]" value={pin} onChange={(e) => setPin(e.target.value)} />
            {wait > 0 ? (
              <p className="text-[12px] text-destructive" role="alert">
                {tw("pin.wait", { time: formatWait(wait) })}
              </p>
            ) : (
              error && <p className="text-[12px] text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={busy || !pin || wait > 0}>
              {busy && <Loader2 className="animate-spin" />}
              {tc("confirm")}
            </Button>
          </form>
        )}
        {secret && (
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {t("hide")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
