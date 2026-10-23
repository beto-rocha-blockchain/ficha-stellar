import type { ReactNode } from "react";

/** Screen title row: mono eyebrow label (optional), display title, actions on the right. */
export function PageHeader({ title, label, actions }: { title: string; label?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        {label && <div className="label-op mb-1.5">{label}</div>}
        <h1 className="truncate font-display text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
