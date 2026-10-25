/**
 * Root layout and wallet gate:
 *  - no wallet     -> /welcome (except PUBLIC_PATHS); a pay link (/p, /pay)
 *                     opened so is kept and opened once the wallet exists
 *  - locked        -> full-screen PIN prompt (except PUBLIC_PATHS)
 *  - unlocked      -> app shell
 * PUBLIC_PATHS work without an unlocked wallet (map, venue list, receipt link, the battery reading,
 * and the host's refund page, signed in Freighter).
 */
import { useEffect } from "react";
import { Link, Navigate, Outlet, createRootRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/AppShell";
import { BiometricOffer } from "@/components/BiometricOffer";
import { LanguageGate } from "@/components/LanguageGate";
import { LockScreen } from "@/components/LockScreen";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { clearPendingLink, pendingLink, rememberPendingLink } from "@/lib/pending-link";
import { useAutoLock, useWallet } from "@/wallet";

const PUBLIC_PATHS = ["/stations", "/estabelecimentos", "/r", "/battery", "/refund"];

function matches(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

export const Route = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  const status = useWallet((s) => s.status);
  const init = useWallet((s) => s.init);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  useAutoLock();

  useEffect(() => {
    void init();
  }, [init]);

  const isPublic = PUBLIC_PATHS.some((p) => matches(path, p));
  const isWelcome = matches(path, "/welcome");

  // The wallet exists and the app is past /welcome: a kept pay link was opened (or is moot).
  useEffect(() => {
    if (status !== "loading" && status !== "none" && !isWelcome) clearPendingLink();
  }, [status, isWelcome]);

  let body: React.ReactNode;
  if (status === "loading") {
    body = (
      <div className="grid min-h-dvh place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  } else if (status === "none" && !isPublic && !isWelcome) {
    // A station's pay link with no wallet yet: create one, then come back to it.
    rememberPendingLink(path, searchStr);
    body = <Navigate to="/welcome" replace />;
  } else if (status !== "none" && isWelcome) {
    const pending = pendingLink();
    body = pending ? <NavigateHref href={pending} /> : <Navigate to="/" replace />;
  } else if (isWelcome) {
    body = <Outlet />;
  } else if (status === "locked" && !isPublic) {
    body = <LockScreen />;
  } else {
    body = (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  }

  return (
    <>
      <LanguageGate />
      <BiometricOffer />
      {body}
      <Toaster position="top-center" theme="dark" />
    </>
  );
}

/** <Navigate> for an in-app href with its raw query (the pay screens read it as is). */
function NavigateHref({ href }: { href: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ href, replace: true });
  }, [navigate, href]);
  return null;
}

function NotFound() {
  const t = useT("common");
  return (
    <div className="py-10 text-center">
      <p className="font-mono text-sm text-muted-foreground">{t("notFound")}</p>
      <Button asChild variant="outline" className="mt-4">
        <Link to="/">{t("goHome")}</Link>
      </Button>
    </div>
  );
}
