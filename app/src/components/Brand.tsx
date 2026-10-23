/**
 * The ONLY place the Ficha logo is rendered. The SVGs are read at build time
 * from the repo's brand/ folder (alias @brand), so a new logo with the same
 * file names (brand/ficha-mark.svg, brand/ficha-logo.svg) drops in with no
 * code change. SVGs painted with currentColor take the text colour
 * (the `brand-mark` class = --primary).
 */
import markRaw from "@brand/ficha-mark.svg?raw";
import logoRaw from "@brand/ficha-logo.svg?raw";
import { cn } from "@/lib/utils";

function prepare(svg: string, label: string): string {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
      const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, "");
      const hasLabel = /aria-label=/.test(cleaned);
      return `<svg${cleaned} width="100%" height="100%" focusable="false"${hasLabel ? "" : ` role="img" aria-label="${label}"`}>`;
    })
    .trim();
}

const MARK = prepare(markRaw, "Ficha");
const LOGO = prepare(logoRaw, "Ficha");

interface BrandProps {
  className?: string;
  /** "mark" = the round symbol; "logo" = symbol + wordmark. */
  variant?: "mark" | "logo";
}

export function Brand({ className, variant = "logo" }: BrandProps) {
  return (
    <span
      className={cn("brand-mark inline-block shrink-0 [&>svg]:block", variant === "mark" ? "h-8 w-8" : "h-8 w-[100px]", className)}
      dangerouslySetInnerHTML={{ __html: variant === "mark" ? MARK : LOGO }}
    />
  );
}

export function BrandMark({ className }: { className?: string }) {
  return <Brand variant="mark" className={className} />;
}
