import { useState } from "react";
import { toast } from "sonner";
import { Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { MAX_BIOMETRIC_FAILURES } from "@/wallet/biometric";
import { answerBiometricOffer, useBiometricOffer } from "@/wallet/biometric-offer";

/**
 * "Use biometrics to unlock?", asked once after a PIN unlock in the Android
 * app (src/wallet/biometric-offer.ts). Mounted in the root layout.
 */
export function BiometricOffer() {
  const t = useT("biometric");
  const open = useBiometricOffer((s) => s.open);
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);

  const answer = async (accept: boolean) => {
    if (busy) return;
    setBusy(accept ? "yes" : "no");
    try {
      const r = await answerBiometricOffer(accept, { title: t("prompt.enableTitle"), subtitle: t("prompt.enableSubtitle"), cancel: t("prompt.cancel") });
      if (r === "enabled") toast.success(t("enabled"));
      else if (r === "declined" || r === "cancelled") toast(t("offer.laterHint"));
      else toast.error(`${t("enableFailed")} ${t("offer.laterHint")}`);
    } catch {
      toast.error(`${t("enableFailed")} ${t("offer.laterHint")}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && void answer(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5 text-primary" /> {t("offer.title")}
          </DialogTitle>
          <DialogDescription>{t("offer.body")}</DialogDescription>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">{t("offer.note", { n: MAX_BIOMETRIC_FAILURES })}</p>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void answer(false)}>
            {busy === "no" && <Loader2 className="animate-spin" />}
            {t("offer.decline")}
          </Button>
          <Button type="button" disabled={busy !== null} onClick={() => void answer(true)}>
            {busy === "yes" ? <Loader2 className="animate-spin" /> : <Fingerprint />}
            {t("offer.accept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
