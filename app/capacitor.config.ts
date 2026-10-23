import type { CapacitorConfig } from "@capacitor/cli";

// Android shell around the web build in dist/ (see README "Android").
const config: CapacitorConfig = {
  appId: "app.ficha.wallet",
  appName: "Ficha",
  webDir: "dist",
  // App background (dark) behind the WebView, so there is no white flash before the first paint.
  backgroundColor: "#05080f",
  android: {
    // The app is served from https://localhost inside the WebView.
    allowMixedContent: false,
    // Android 15 draws apps edge to edge; keep the page clear of the status and nav bars.
    adjustMarginsForEdgeToEdge: "auto",
  },
  plugins: {
    StatusBar: { style: "DARK", backgroundColor: "#05080f", overlaysWebView: false },
  },
};

export default config;
