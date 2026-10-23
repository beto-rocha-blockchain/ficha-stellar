/**
 * Testnet only: activate the wallet's account with Friendbot's test XLM
 * right where a payment needs it (/p, /pay, /buy), then read the balance
 * again, so the user stays on the page (and its pay link) instead of going
 * Home and scanning again. Renders nothing on a network without Friendbot.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { fundWithFriendbot, useNetwork } from "@/stellar";
import { useWallet } from "@/wallet";

export function ActivateTestnet({ onDone, className }: { onDone: () => void | Promise<void>; className?: string }) {
  const t = useT("home");
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const [busy, setBusy] = useState(false);
  if (!net.friendbotUrl || !publicKey) return null;

  const activate = async () => {
    setBusy(true);
    try {
      await fundWithFriendbot(net, publicKey);
      toast.success(t("friendbotOk"));
      await onDone();
    } catch {
      toast.error(t("friendbotFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button onClick={() => void activate()} disabled={busy} className={className}>
      {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
      {t("friendbot")}
    </Button>
  );
}
