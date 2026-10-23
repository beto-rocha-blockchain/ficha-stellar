import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import { formatWait } from "@/lib/format";
import { BiometricError, biometricSupport, type BiometricSupport } from "@/native/biometric";
import { PinLockedError, WrongPinError, usePinWait, useWallet } from "@/wallet";
import { loadBiometricRecord, turnOffBiometric } from "@/wallet/biometric";

/**
 * Ajustes → Segurança: the biometric unlock switch (src/wallet/biometric.ts).
 * Turning it on asks for the PIN, then the biometrics; off asks for nothing.
 * Renders nothing on the web, where there are no biometrics to use.
 * `onEnabledChange` tells Ajustes whether the app opens with biometrics or the PIN.
 */
export function BiometricSetting({ onEnabledChange }: { onEnabledChange?: (enabled: boolean) => void }) {
  const t = useT("biometric");
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [s, rec] = await Promise.all([biometricSupport(), loadBiometricRecord().catch(() => null)]);
    setSupport(s);
    setEnabled(rec !== null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    onEnabledChange?.(enabled);
  }, [enabled, onEnabledChange]);

  if (!support) return null;

  const hint = enabled || support.strong
    ? t("settings.body")
    : support.reason === "none_enrolled"
      ? t("settings.noneEnrolled")
      : support.available
        ? t("settings.notStrong")
        : t("settings.unavailable");

  const toggle = async (on: boolean) => {
    if (on) {
      setPinOpen(true);
      return;
    }
    setBusy(true);
    try {
      await turnOffBiometric();
      setEnabled(false);
      toast.success(t("disabled"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2.5 text-sm">
        <Fingerprint className="h-4 w-4 text-primary" />
        <Label htmlFor="biometric-switch" className="flex-1 font-normal">
          {t("settings.label")}
        </Label>
        <Switch id="biometric-switch" checked={enabled} disabled={busy || (!enabled && !support.strong)} onCheckedChange={(on) => void toggle(on)} />
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      <EnableDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        onEnabled={() => {
          setEnabled(true);
          toast.success(t("enabled"));
        }}
      />
    </>
  );
}

function EnableDialog({ open, onOpenChange, onEnabled }: { open: boolean; onOpenChange: (o: boolean) => void; onEnabled: () => void }) {
  const t = useT("biometric");
  const tw = useT("wallet");
  const tc = useT("common");
  const enableBiometric = useWallet((s) => s.enableBiometric);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wait = usePinWait();

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) {
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
      await enableBiometric(pin, { title: t("prompt.enableTitle"), subtitle: t("prompt.enableSubtitle"), cancel: t("prompt.cancel") });
      setBusy(false);
      setPin("");
      onOpenChange(false);
      onEnabled();
      return;
    } catch (err) {
      if (err instanceof WrongPinError) setError(tw("pin.wrong"));
      else if (err instanceof BiometricError) setError(err.code === "cancelled" ? null : t("enableFailed"));
      else if (!(err instanceof PinLockedError)) setError(String(err));
    }
    setPin("");
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("settings.pinTitle")}</DialogTitle>
          <DialogDescription>{t("settings.pinBody")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Label htmlFor="biometric-pin">{tw("pin.label")}</Label>
          <Input id="biometric-pin" type="password" autoComplete="current-password" autoFocus className="h-11 font-mono tracking-[0.3em]" value={pin} onChange={(e) => setPin(e.target.value)} />
          {wait > 0 ? (
            <p className="text-[12px] text-destructive" role="alert">
              {tw("pin.wait", { time: formatWait(wait) })}
            </p>
          ) : (
            error && <p className="text-[12px] text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !pin || wait > 0}>
              {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
              {tc("confirm")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
