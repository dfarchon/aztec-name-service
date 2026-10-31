import { config } from "./config";
type Sample = { name: string; value: number; rating: string };
const samples: Record<string, Sample> = {};
export const getVitals = () => ({ ...samples });
export function startVitals() {
  const start = async () => {
    const { onCLS, onINP, onLCP } = await import("web-vitals");
    const report = (m: Sample) => {
      samples[m.name] = { name: m.name, value: m.value, rating: m.rating };
      if (import.meta.env.PROD && import.meta.env.VITE_TELEMETRY === "true") {
        navigator.sendBeacon("/api/metrics", new Blob([JSON.stringify({ release: config.release, name: m.name, value: m.value })], { type: "application/json" }));
      }
    };
    onCLS(report); onINP(report); onLCP(report);
  };
  const run = () => { void start().catch(() => {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run);
  else setTimeout(run, 1500);
}
