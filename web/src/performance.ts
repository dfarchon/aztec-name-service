import { apiUrl, config } from "./config";
type Sample = { name: string; value: number; rating: string };
const samples: Record<string, Sample> = {};
export const getVitals = () => ({ ...samples });
export function startVitals() {
  const start = async () => {
    const { onCLS, onINP, onLCP } = await import("web-vitals");
    const report = (m: Sample) => {
      samples[m.name] = { name: m.name, value: m.value, rating: m.rating };
      if (import.meta.env.PROD && import.meta.env.VITE_TELEMETRY === "true") {
        // A CORS-mode request always carries the real Origin, which the API checks, even under Referrer-Policy: no-referrer.
        // text/plain keeps it a simple request (no preflight) when the API is on another origin; keepalive outlives the page.
        void fetch(apiUrl("/api/metrics"), {
          method: "POST", mode: "cors", credentials: "omit", keepalive: true,
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ release: config.release, name: m.name, value: m.value }),
        }).catch(() => { /* Telemetry is best effort. */ });
      }
    };
    onCLS(report); onINP(report); onLCP(report);
  };
  const run = () => { void start().catch(() => {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run);
  else setTimeout(run, 1500);
}
