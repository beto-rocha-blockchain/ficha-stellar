import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const t = useT("common");
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        if (await copyText(value)) {
          setDone(true);
          toast.success(t("copied"));
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {label ?? t("copy")}
    </Button>
  );
}
