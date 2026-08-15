import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative asset URLs so a build also works when opened from a subfolder.
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "icons/apple-touch-icon.png"],
      workbox: {
        // Precache the whole app so it opens with no server running.
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
      },
      manifest: {
        name: "Bandshell",
        short_name: "Bandshell",
        description: "A stripped-back music studio — record, arrange, and export.",
        theme_color: "#232323",
        background_color: "#232323",
        display: "standalone",
        orientation: "landscape",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
