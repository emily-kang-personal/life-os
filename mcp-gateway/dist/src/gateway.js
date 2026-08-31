import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server, } from "@modelcontextprotocol/server";
export function createActiveCallRegistry(limit) {
    let active = 0;
    let waiters = [];
    return Object.freeze({
        tryRegister: () => {
            if (active >= limit) {
                return undefined;
            }
            active += 1;
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                active -= 1;
                if (active === 0) {
                    const resolved = waiters;
                    waiters = [];
                    for (const resolve of resolved) {
                        resolve();
                    }
                }
            };
        },
        waitForEmpty: () => {
            if (active === 0) {
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                waiters.push(resolve);
            });
        },
    });
}
const BUSY_RESULT = Object.freeze({
    content: [{ type: "text", text: "Gateway busy" }],
    isError: true,
});
const TIMEOUT_RESULT = Object.freeze({
    content: [{ type: "text", text: "Gateway timeout" }],
    isError: true,
});
const DOWNSTREAM_ERROR_RESULT = Object.freeze({
    content: [{ type: "text", text: "Downstream unavailable" }],
    isError: true,
});
/**
 * Forwards one tool call to its source without mutation or retry. Precedence
 * on failure: caller cancellation, then shutdown, then timeout, then a
 * generic downstream error. Successful results pass through unchanged.
 */
export async function forwardToolCall(params, requestId, callerSignal, deps) {
    const route = deps.toolIndex.get(params.name);
    if (route === undefined) {
        deps.log({ event: "call_denied", reason: "unknown_tool" });
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Tool not found");
    }
    const release = deps.activeCalls.tryRegister();
    if (release === undefined) {
        deps.log({ event: "call_denied", reason: "busy" });
        return BUSY_RESULT;
    }
    const timeoutSignal = AbortSignal.timeout(deps.callTimeoutMs);
    const combinedSignal = AbortSignal.any([callerSignal, deps.shutdownSignal, timeoutSignal]);
    const startedAt = performance.now();
    deps.log({
        event: "call_start",
        requestId,
        sourceId: route.sourceId,
        tool: params.name,
    });
    let outcome = "error";
    try {
        const result = await route.client.callTool({ name: params.name, arguments: params.arguments }, 
        // The SDK's own request timeout sits above ours so classification
        // (timeout vs downstream failure) stays gateway-owned. requestSignal
        // additionally tears down the underlying POST so the downstream's
        // per-request signal fires; the protocol-level signal alone cannot
        // reach an in-flight stateless request.
        {
            signal: combinedSignal,
            requestSignal: combinedSignal,
            timeout: deps.callTimeoutMs + 1_000,
        });
        outcome = "ok";
        return result;
    }
    catch (error) {
        if (callerSignal.aborted || deps.shutdownSignal.aborted) {
            outcome = "cancelled";
            throw error;
        }
        if (timeoutSignal.aborted) {
            outcome = "timeout";
            return TIMEOUT_RESULT;
        }
        return DOWNSTREAM_ERROR_RESULT;
    }
    finally {
        deps.log({
            event: "call_end",
            requestId,
            sourceId: route.sourceId,
            tool: params.name,
            outcome,
            durationMs: Math.round(performance.now() - startedAt),
        });
        release();
    }
}
/**
 * Builds the SDK HTTP handler. The cheap per-request factory creates a fresh
 * low-level Server exposing only tools/list and tools/call, closing over the
 * immutable tool index and shared downstream clients.
 */
export function createGatewayMcpHandler(deps) {
    return createMcpHandler(() => {
        const server = new Server({ name: "mcp-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler("tools/list", () => ({
            tools: [...deps.toolIndex.orderedTools()],
        }));
        server.setRequestHandler("tools/call", (request, ctx) => forwardToolCall({
            name: request.params.name,
            arguments: request.params.arguments,
        }, String(ctx.mcpReq.id), ctx.mcpReq.signal, deps));
        return server;
    }, {
        legacy: "stateless",
        // Reporting-only; SDK errors may embed URLs or headers, so drop them.
        onerror: () => { },
    });
}
