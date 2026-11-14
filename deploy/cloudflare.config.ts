// Assets-only Workers Static Assets site (ADR 0008). No Worker code runs.
// Deployed only by scripts/deploy.sh from a verified, signed release bundle.
import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "trail-braking-trainer",
    compatibilityDate: "2026-11-01",
    assets: { notFoundHandling: "single-page-application" },
    domains: ["trail-braking-trainer.aru.sh"],
    workersDev: true,
    // Version preview URLs for release review; gated by Cloudflare Access (ADR 0010).
    previewUrls: true,
  },
});
