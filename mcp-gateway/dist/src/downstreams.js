import { Client, StreamableHTTPClientTransport, } from "@modelcontextprotocol/client";
import { StartupError } from "./config.js";
const CLIENT_INFO = { name: "mcp-gateway", version: "0.1.0" };
/**
 * Connects one shared client per configured source. All connects start under
 * a shared startup abort controller with a wall-clock timeout; the first
 * rejection aborts the peer, every fulfilled or late-fulfilled client is
 * closed, and one sanitized StartupError is thrown. After markReady(), an
 * unexpected client close invokes onFatal (deliberate close() does not).
 */
export async function connectDownstreams(config, onFatal) {
    let ready = false;
    let closing = false;
    const startup = new AbortController();
    const startupTimer = setTimeout(() => startup.abort(), config.startupTimeoutMs);
    startupTimer.unref();
    let firstFailure;
    const pendings = config.sources.map((source) => {
        const transport = new StreamableHTTPClientTransport(new URL(source.url), {
            requestInit: {
                headers: { [source.auth.header]: source.auth.prefix + source.credential },
            },
        });
        // 'auto' negotiation: modern era (working per-request cancellation) when
        // the downstream definitively supports it, legacy initialize otherwise —
        // the SDK default of 'legacy' would never negotiate modern at all.
        const client = new Client(CLIENT_INFO, {
            versionNegotiation: { mode: "auto" },
        });
        // Out-of-band downstream errors may embed URLs/headers; never surface them.
        client.onerror = () => { };
        client.onclose = () => {
            if (ready && !closing) {
                onFatal("downstream_closed", source.id);
            }
        };
        const promise = client.connect(transport);
        promise.catch(() => {
            if (firstFailure === undefined) {
                firstFailure = new StartupError("downstream_connect_failed", source.id);
            }
            startup.abort();
        });
        return { sourceId: source.id, client, transport, promise };
    });
    const aborted = new Promise((_, reject) => {
        startup.signal.addEventListener("abort", () => reject(firstFailure ?? new StartupError("startup_timeout")), { once: true });
    });
    try {
        await Promise.race([Promise.all(pendings.map((p) => p.promise)), aborted]);
    }
    catch (error) {
        clearTimeout(startupTimer);
        closing = true;
        // Force settlement, then close every fulfilled or late-fulfilled client.
        await Promise.allSettled(pendings.map(async (p) => {
            p.promise.catch(() => { });
            await p.client.close().catch(() => { });
            await p.transport.close().catch(() => { });
        }));
        throw error instanceof StartupError ? error : new StartupError("startup_failed");
    }
    clearTimeout(startupTimer);
    const connected = Object.freeze(pendings.map((p) => Object.freeze({ sourceId: p.sourceId, client: p.client })));
    return Object.freeze({
        handles: () => connected,
        markReady: () => {
            ready = true;
        },
        close: async () => {
            closing = true;
            await Promise.allSettled(pendings.map((p) => p.client.close()));
        },
    });
}
/**
 * Aggregates every tools/list page from each source in deterministic order,
 * requires a non-empty inventory per source, rejects duplicate native names,
 * and returns a closure-owned immutable lookup with no mutable alias.
 */
export async function buildToolIndex(handles) {
    const index = new Map();
    for (const handle of handles) {
        let tools;
        try {
            // The no-cursor call aggregates every page client-side.
            const result = await handle.client.listTools();
            tools = result.tools;
        }
        catch {
            throw new StartupError("tool_discovery_failed", handle.sourceId);
        }
        if (tools.length === 0) {
            throw new StartupError("empty_tool_inventory", handle.sourceId);
        }
        for (const rawTool of tools) {
            if (index.has(rawTool.name)) {
                throw new StartupError("duplicate_tool_name", handle.sourceId);
            }
            index.set(rawTool.name, {
                sourceId: handle.sourceId,
                client: handle.client,
                rawTool,
            });
        }
    }
    const ordered = Object.freeze([...index.values()].map((route) => route.rawTool));
    return Object.freeze({
        get: (name) => index.get(name),
        orderedTools: () => ordered,
    });
}
