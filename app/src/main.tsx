import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/montserrat/latin-700.css";
import "./styles.css";
import { routeTree } from "./routeTree.gen";
import { useUi } from "./store/ui";
import { reloadGate, setupServiceWorker } from "./native/service-worker";
import { useWallet } from "./wallet";
import { setupDeepLinks } from "./native/deep-links";

// "/" in dev, in the Android app and on the Ficha site; a sub-path only with VITE_BASE (vite.config.ts appBase).
const basepath = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";
const router = createRouter({ routeTree, basepath, defaultPreload: "intent", scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

document.documentElement.lang = useUi.getState().lang;

// Web: after a site publish, reload into the new build where that loses nothing.
void setupServiceWorker(
  reloadGate({
    path: () => router.state.location.pathname,
    wallet: useWallet,
    onRoute: (cb) => router.subscribe("onResolved", cb),
  }),
);
// Android: pay links and receipts open the app on the right page (AndroidManifest intent filters).
void setupDeepLinks((href) => void router.navigate({ href }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
