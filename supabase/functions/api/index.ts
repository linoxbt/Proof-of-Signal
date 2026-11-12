// Supabase Edge Function `api`: every /v1/* endpoint of contracts/api.md
// except the probe and the watcher control endpoints.

import { createApp } from "./app.ts";

const app = createApp();
Deno.serve((req, info) => app.handler(req, info as { remoteAddr?: { hostname?: string } }));
