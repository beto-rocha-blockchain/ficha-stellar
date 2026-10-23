import type { LucideIcon } from "lucide-react";
import { Construction } from "lucide-react";
import { useT } from "@/i18n";
import { PageHeader } from "./PageHeader";

/** Temporary screen for a route another task is building. */
export function Placeholder({ title, owner, icon: Icon = Construction }: { title: string; owner: string; icon?: LucideIcon }) {
  const t = useT("common");
  return (
    <div className="space-y-4">
      <PageHeader title={title} />
      <div className="rounded-xl border border-dashed border-border bg-card/60 py-10 text-center">
        <Icon className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <p className="mt-3 font-mono text-sm text-muted-foreground">{t("placeholder.soon")}</p>
        <p className="mt-1 text-[12px] text-muted-foreground/80">{t("placeholder.body")}</p>
        <p className="mt-3 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">{owner}</p>
      </div>
    </div>
  );
}
