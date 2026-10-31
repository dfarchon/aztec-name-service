import { probe, type MonitorEnv } from './worker';
// A separate Worker probes the public website; self-fetch on a Worker does not establish public availability.
export default {
  async fetch(request: Request, env: MonitorEnv) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/probe') return new Response(null, { status: 404 });
    return Response.json(await probe(env), { headers: { 'Cache-Control': 'no-store' } });
  },
  async scheduled(_event: ScheduledController, env: MonitorEnv) { await probe(env); },
} satisfies ExportedHandler<MonitorEnv>;
