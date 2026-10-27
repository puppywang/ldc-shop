import nextWorker from "./.open-next/worker.js";
import { runScheduledCleanup } from "./scheduled-cleanup.mjs";

export default {
    async fetch(request, env, ctx) {
        return nextWorker.fetch(request, env, ctx);
    },
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledCleanup(env));
    },
};

export * from "./.open-next/worker.js";
