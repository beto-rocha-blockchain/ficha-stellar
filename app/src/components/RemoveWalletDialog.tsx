import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { formatWait } from "@/lib/format";
import { PinLockedError, WrongPinError, usePinWait, useWallet } from "@/wallet";

/**
 * Erase the wallet from this phone. From Ajustes the PIN is checked first.
 * From the lock screen ("Esqueceu o PIN?") it cannot be, so only the words
 * acknowledgment guards it: whoever holds the phone could clear the app's data
 * from the system settings anyway, and the balance stays on the network.
 */
export function RemoveWalletDialog({ open, onOpenChange, requirePin }: { open: boolean; onOpenChange: (o: boolean) => void; requirePin: boolean }) {
  const t = useT("settings");
  const tw = useT("wallet");
  const tc = useT("common");
  const reveal = useWallet((s) => s.reveal);
  const remove = useWallet((s) => s.remove);
  const navigate = useNavigate();
  const [ack, setAck] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wait = usePinWait();
  const waiting = requirePin && wait > 0;

  // The dialog stays mounted while closed: forget the acknowledgment on close,
  // or reopening it (from the lock screen, the only guard) is a one-tap erase.
  const close = (o: boolean) => {
    if (!o) {
      setAck(false);
      setPin("");
      setError(null);
    }
    onOpenChange(o);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (requirePin) await reveal(pin); // proves the PIN before erasing
      await remove();
      toast.success(t("removed"));
      close(false);
      void navigate({ to: "/welcome" });
    } catch (err) {
      setError(err instanceof WrongPinError ? tw("pin.wrong") : err instanceof PinLockedError ? null : String(err));
      setBusy(false);
    } finally {
      setPin("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("removeTitle")}</DialogTitle>
          {!requirePin && <p className="text-sm text-muted-foreground">{tw("unlock.forgotBody")}</p>}
          <DialogDescription>{t("removeBody")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-[var(--destructive)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {t("removeAck")}
          </label>
          {requirePin && (
            <>
              <Label htmlFor="remove-pin">{tw("pin.label")}</Label>
              <Input id="remove-pin" type="password" autoComplete="current-password" className="h-11 font-mono tracking-[0.3em]" value={pin} onChange={(e) => setPin(e.target.value)} />
            </>
          )}
          {waiting ? (
            <p className="text-[12px] text-destructive" role="alert">
              {tw("pin.wait", { time: formatWait(wait) })}
            </p>
          ) : (
            error && <p className="text-[12px] text-destructive">{error}</p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={!ack || (requirePin && !pin) || waiting || busy}>
              {busy && <Loader2 className="animate-spin" />}
              {t("removeConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
