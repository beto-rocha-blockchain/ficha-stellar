/**
 * Anfitrião → a station's terms on the custody contract (register, contract
 * §7.1): a new station, or new terms for one of this host's, signed on this
 * phone. Prefilled from the terms on the contract, else from the signed
 * registry's entry, else the defaults; checked against the contract's bounds
 * as the host types, compared with the registry (whose match rules decide
 * whether payers' apps accept the station, contract §7.4 step 3), and
 * simulated before anything is signed.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Loader2, ShieldAlert, ShieldCheck, Store } from "lucide-react";
import { explorerUrl, type AssetRef, type NetworkConfig } from "@/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { RequireUnlocked } from "@/components/RequireUnlocked";
import { useHostContext } from "@/hooks/useHostContext";
import { useLang, useT } from "@/i18n";
import { chainLength } from "@/custody/chain";
import { termsMismatches } from "@/custody/check";
import { describeHostError } from "@/custody/describe";
import { EscrowError } from "@/custody/errors";
import type { StationTerms } from "@/custody/escrow";
import {
  RECOMMENDED_GRACE_SECONDS,
  STATION_MIN_GRACE_SECONDS,
  assetOfToken,
  defaultEscrow,
  formFromRegistry,
  formFromTerms,
  formProblems,
  graceBelowStation,
  prepareRegister,
  registryFields,
  sendHostCall,
  termsFromForm,
  type HostCallDone,
  type StationForm,
} from "@/custody/host";
import { hostViewKey, useHost, xlmFeeCheck, type HostContext } from "@/custody/host-store";
import { STATION_ID_RE, isCustody, stationsByHostKey, useRegistry, type Station } from "@/registry";
import { formatAmount, multiplyAmount, useNetwork } from "@/stellar";
import { signTransaction } from "@/wallet";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/host/station")({
  // The router parses search values as JSON: an all-digit ID comes as a number.
  validateSearch: (s: Record<string, unknown>): { id?: string } => {
    const id = typeof s.id === "string" || typeof s.id === "number" ? String(s.id).toUpperCase() : "";
    return STATION_ID_RE.test(id) ? { id } : {};
  },
  component: HostStationScreen,
});

const XLM: AssetRef = { code: "XLM", issuer: null };

/** What the inputs hold: text, parsed on every change. */
interface Draft {
  id: string;
  asset: "XLM" | "USDC";
  price: string;
  fichaMinutes: string;
  maxSessionMinutes: string;
  unitSeconds: string;
  graceSeconds: string;
  active: boolean;
}

const DEFAULTS: Omit<StationForm, "id"> = { asset: XLM, price: "1", fichaMinutes: 5, maxSessionMinutes: 60, unitSeconds: 30, graceSeconds: RECOMMENDED_GRACE_SECONDS, active: true };

function toDraft(f: StationForm): Draft {
  return {
    id: f.id,
    asset: f.asset.issuer === null ? "XLM" : "USDC",
    price: f.price,
    fichaMinutes: String(f.fichaMinutes),
    maxSessionMinutes: String(f.maxSessionMinutes),
    unitSeconds: String(f.unitSeconds),
    graceSeconds: String(f.graceSeconds),
    active: f.active,
  };
}

function fromDraft(d: Draft, net: NetworkConfig): StationForm {
  const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s.trim()));
  return {
    id: d.id.trim().toUpperCase(),
    asset: d.asset === "XLM" ? XLM : { code: net.usdc.code, issuer: net.usdc.issuer },
    // A decimal comma, as Brazilians type it.
    price: d.price.trim().replace(",", "."),
    fichaMinutes: num(d.fichaMinutes),
    maxSessionMinutes: num(d.maxSessionMinutes),
    unitSeconds: num(d.unitSeconds),
    graceSeconds: num(d.graceSeconds),
    active: d.active,
  };
}

const sameTerms = (a: StationTerms, b: StationTerms) =>
  a.token === b.token && a.price === b.price && a.fichaSecs === b.fichaSecs && a.maxFichas === b.maxFichas && a.unitSecs === b.unitSecs && a.graceSecs === b.graceSecs && a.active === b.active;

function HostStationScreen() {
  const t = useT("host");
  const tc = useT("common");
  const { id } = Route.useSearch();
  const net = useNetwork();
  const ctx = useHostContext();
  const regStatus = useRegistry().status;
  const key = useHost((s) => s.key);
  const view = useHost((s) => s.view);
  const error = useHost((s) => s.error);
  const load = useHost((s) => s.load);
  const ready = regStatus !== "loading" && regStatus !== "idle";
  const mine = ctx && key === hostViewKey(net, ctx.host) ? view : null;

  // Opened directly (a link, a reload): read the host's view first.
  useEffect(() => {
    if (ctx && ready && !mine) void load(ctx);
  }, [ctx, ready, mine, load]);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/host">
          <ArrowLeft /> {t("f.back")}
        </Link>
      </Button>
      <PageHeader label={`${t("label")} · ${net.label}`} title={id ? t("f.titleEdit", { id }) : t("f.titleNew")} />
      {!net.custody ? (
        <Blocked text={t("testnetOnly")} />
      ) : error != null && !mine ? (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" /> {t("loadFailed")}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{describeHostError(error)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => ctx && void load(ctx)}>
            {tc("retry")}
          </Button>
        </div>
      ) : !mine || !ctx ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" /> {t("loading")}
        </div>
      ) : (
        <StationFormView key={id ?? ""} ctx={ctx} id={id} />
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

function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function StationFormView({ ctx, id }: { ctx: HostContext; id?: string }) {
  const t = useT("host");
  const tc = useT("common");
  const { lang } = useLang();
  const net = ctx.net;
  const view = useHost((s) => s.view)!;
  const mineInRegistry = stationsByHostKey(ctx.registry, ctx.host);
  const entryFor = (sid: string): Station | undefined => mineInRegistry.find((s) => s.id === sid);
  // The contract a station's terms go to: the one the registry names for it, else the registry's
  // default (after a testnet reset, the new deployment), and the app's own only without a registry.
  const escrowFor = (sid: string) => {
    const e = entryFor(sid);
    return isCustody(e) ? e.escrow : defaultEscrow(ctx.registry, net);
  };
  const onChain = (sid: string) => view.stations.find((s) => s.escrow === escrowFor(sid) && s.id === sid)?.terms ?? null;

  const [draft, setDraft] = useState<Draft>(() => {
    const terms = id ? onChain(id) : null;
    if (id && terms) return toDraft(formFromTerms(id, terms, assetOfToken(terms.token, net) ?? XLM));
    const entry = id ? entryFor(id) : undefined;
    if (entry) return toDraft(formFromRegistry(entry));
    return toDraft({ id: id ?? "", ...DEFAULTS });
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [done, setDone] = useState<HostCallDone | null>(null);

  const form = fromDraft(draft, net);
  const problems = formProblems(form, net);
  const terms = problems.length === 0 ? termsFromForm(form, net) : null;
  const escrow = escrowFor(form.id);
  const pinned = view.escrows.find((e) => e.id === escrow)?.pinned ?? false;
  const current = STATION_ID_RE.test(form.id) ? onChain(form.id) : null;
  const unchanged = terms !== null && current !== null && sameTerms(current, terms);
  const entry = STATION_ID_RE.test(form.id) ? entryFor(form.id) : undefined;
  const listed = isCustody(entry) && entry.escrow === escrow;
  const differs = terms && listed ? termsMismatches(entry, terms, net) : [];
  const fields = terms && !listed ? JSON.stringify(registryFields(terms, escrow, form.asset)) : null;
  const fichaSecs = Number.isInteger(form.fichaMinutes) ? form.fichaMinutes * 60 : 0;
  const maxF = form.fichaMinutes > 0 ? Math.floor(form.maxSessionMinutes / form.fichaMinutes) : 0;
  const n = form.unitSeconds > 0 && fichaSecs > 0 ? chainLength({ fichaSecs, unitSecs: form.unitSeconds, maxFichas: maxF }) : 0;
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setFailure(null);
  };

  const submit = async () => {
    if (!terms || busy || unchanged || !pinned) return;
    setBusy(true);
    setFailure(null);
    try {
      // Simulated first: terms out of bounds, or an authorization other than the host's register, throw here.
      const p = await prepareRegister(ctx.server, net, { escrow, host: ctx.host, station: form.id, terms });
      await xlmFeeCheck(net, ctx.host)(p.fee);
      const sent = await sendHostCall(ctx.server, escrow, p, signTransaction);
      useHost.getState().registered(ctx, escrow, form.id, terms);
      setDone(sent);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-success/40 bg-success/10 p-6 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
          <div className="mt-3 font-display text-xl font-semibold">{t("f.done")}</div>
          <div className="mt-1 font-mono text-sm text-muted-foreground">{form.id}</div>
        </div>
        {fields && <RegistryFields text={t("f.registryMissing")} fields={fields} />}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/host">
              <Store /> {t("f.back")}
            </Link>
          </Button>
          <Button asChild variant="ghost">
            <a href={explorerUrl(net, "tx", done.hash)} target="_blank" rel="noreferrer">
              <ExternalLink /> {t("viewTx")}
            </a>
          </Button>
        </div>
      </div>
    );
  }

  const problemText = (p: string) => t(`problem.${p}`, { secs: fichaSecs, n });
  const asset = form.asset;

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t("f.intro")}</p>
      {!pinned && <Blocked text={t("unknownCode", { id: escrow })} />}

      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <Field label={t("f.id")} hint={t("f.idHint")} htmlFor="host-id">
          <Input
            id="host-id"
            value={draft.id}
            onChange={(e) => set({ id: e.target.value.toUpperCase() })}
            maxLength={6}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            disabled={id !== undefined}
            className="h-11 font-mono tracking-[0.2em]"
          />
        </Field>

        <div className="space-y-1.5">
          <span id="host-asset" className="text-sm font-medium leading-none">
            {t("f.asset")}
          </span>
          <div role="group" aria-labelledby="host-asset" className="grid grid-cols-2 gap-2">
            {/* Custody in XLM only for now: USDC shows only to edit a station already registered in it. */}
            {(draft.asset === "USDC" ? (["XLM", "USDC"] as const) : (["XLM"] as const)).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={draft.asset === a}
                onClick={() => set({ asset: a })}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm transition",
                  draft.asset === a ? "border-primary/60 bg-primary/5 shadow-[var(--shadow-glow)]" : "border-border bg-background/40 hover:border-primary/40",
                )}
              >
                {a}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("f.assetXlmOnly")}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={`${t("f.price")} (${asset.code})`} htmlFor="host-price">
            <Input id="host-price" inputMode="decimal" value={draft.price} onChange={(e) => set({ price: e.target.value })} className="h-11 font-mono" />
          </Field>
          <Field label={t("f.fichaMinutes")} htmlFor="host-ficha">
            <Input id="host-ficha" type="number" inputMode="numeric" min={1} value={draft.fichaMinutes} onChange={(e) => set({ fichaMinutes: e.target.value })} className="h-11 font-mono" />
          </Field>
        </div>

        <Field
          label={t("f.maxSession")}
          htmlFor="host-max"
          hint={
            maxF > 0 && problems.every((p) => p !== "price" && p !== "ficha" && p !== "max")
              ? `${t("f.maxFichas", { fichas: maxF === 1 ? tc("ficha") : tc("fichas", { n: maxF }) })} · ${formatAmount(multiplyAmount(form.price, maxF), lang, 7, 0)} ${asset.code}`
              : undefined
          }
        >
          <Input id="host-max" type="number" inputMode="numeric" min={1} value={draft.maxSessionMinutes} onChange={(e) => set({ maxSessionMinutes: e.target.value })} className="h-11 font-mono" />
        </Field>

        <Field label={t("f.unit")} htmlFor="host-unit" hint={t("f.unitHint", { n: n > 0 && Number.isInteger(n) ? n : "—" })}>
          <Input id="host-unit" type="number" inputMode="numeric" min={1} value={draft.unitSeconds} onChange={(e) => set({ unitSeconds: e.target.value })} className="h-11 font-mono" />
        </Field>

        <Field label={t("f.grace")} htmlFor="host-grace" hint={t("f.graceHint")}>
          <Input id="host-grace" type="number" inputMode="numeric" min={300} max={86400} value={draft.graceSeconds} onChange={(e) => set({ graceSeconds: e.target.value })} className="h-11 font-mono" />
        </Field>

        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="host-active">{t("f.active")}</Label>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("f.activeHint")}</p>
          </div>
          <Switch id="host-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
        </div>
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          {problems.map((p) => (
            <li key={p}>{problemText(p)}</li>
          ))}
        </ul>
      )}
      {!problems.includes("grace") && graceBelowStation(form.graceSeconds) && (
        // The contract takes it; the station would refuse to start (config.py).
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {t("f.graceStation", { min: STATION_MIN_GRACE_SECONDS })}
        </p>
      )}

      {terms && listed && differs.length === 0 && (
        <p className="flex items-start gap-2 text-[12px] text-success">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> {t("reg.match")}
        </p>
      )}
      {differs.length > 0 && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {t("f.registryDiffers", { fields: differs.join(", ") })}
          </p>
          {entry && (
            <Button size="sm" variant="outline" onClick={() => set(toDraft(formFromRegistry(entry)))}>
              {t("f.fromRegistry")}
            </Button>
          )}
        </div>
      )}
      {fields && <RegistryFields text={t("f.registryMissing")} fields={fields} />}
      {unchanged && <p className="text-[12px] text-muted-foreground">{t("f.unchanged")}</p>}

      {failure != null && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border-2 border-destructive bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          {describeHostError(failure)}
        </div>
      )}

      <RequireUnlocked>
        <Button
          size="lg"
          className="w-full"
          onClick={submit}
          disabled={!terms || busy || unchanged || !pinned || (failure instanceof EscrowError && failure.code === "unknown_outcome")}
        >
          {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {busy ? t("sending") : current ? t("f.submitEdit") : t("f.submitNew")}
        </Button>
      </RequireUnlocked>
    </div>
  );
}

function RegistryFields({ text, fields }: { text: string; fields: string }) {
  const t = useT("host");
  return (
    <div className="space-y-2 rounded-md border border-border bg-background/40 p-3 text-[12px]">
      <p className="text-muted-foreground">{text}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="label-op">{t("reg.fields")}</span>
        <CopyButton value={fields} className="h-7" />
      </div>
      <code className="block break-all font-mono text-[10px] text-muted-foreground">{fields}</code>
    </div>
  );
}
