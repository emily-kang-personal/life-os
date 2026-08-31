import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GATEWAY_HOST, GATEWAY_PORT, HEALTH_BODY, HEALTH_PATH, StartupError, loadConfig, } from "./config.js";
import { createLogger } from "./logger.js";
import { buildToolIndex, connectDownstreams } from "./downstreams.js";
import { createActiveCallRegistry, createGatewayMcpHandler } from "./gateway.js";
import { createHttpServer } from "./http.js";
export function logFilePath() {
    return join(homedir(), "Library", "Logs", "life-os", "mcp-gateway.jsonl");
}
/**
 * Full startup per the plan lifecycle: connect both downstreams, build the
 * immutable tool index, create handlers, then bind. No socket listens before
 * every downstream is ready; any startup failure throws one StartupError
 * after closing whatever was opened.
 */
export async function startGateway(config, log, options) {
    const shutdownController = new AbortController();
    const activeCalls = createActiveCallRegistry(config.maxInFlightCalls);
    let shuttingDown = false;
    let registry;
    let handleFatal = (code, sourceId) => {
        log({ event: "fatal", code, sourceId });
    };
    registry = await connectDownstreams(config, (code, sourceId) => {
        handleFatal(code, sourceId);
    });
    let toolIndex;
    try {
        toolIndex = await buildToolIndex(registry.handles());
    }
    catch (error) {
        await registry.close();
        throw error;
    }
    const mcpHandler = createGatewayMcpHandler({
        toolIndex,
        activeCalls,
        shutdownSignal: shutdownController.signal,
        callTimeoutMs: config.callTimeoutMs,
        log,
    });
    const httpServer = createHttpServer(config, mcpHandler);
    try {
        httpServer.listen(config.port, config.host);
        await once(httpServer, "listening");
    }
    catch {
        await mcpHandler.close().catch(() => { });
        await registry.close();
        throw new StartupError("bind_failed");
    }
    registry.markReady();
    log({ event: "ready" });
    const shutdown = async (exitCode) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        httpServer.close();
        httpServer.closeIdleConnections();
        await Promise.race([activeCalls.waitForEmpty(), delay(config.shutdownDrainMs)]);
        shutdownController.abort();
        httpServer.closeAllConnections();
        await mcpHandler.close().catch(() => { });
        await registry.close();
        options.onExit(exitCode);
    };
    handleFatal = (code, sourceId) => {
        log({ event: "fatal", code, sourceId });
        void shutdown(1);
    };
    return Object.freeze({ shutdown });
}
/**
 * Owns process lifecycle for `serve`: signal handlers are installed before
 * async startup, SIGINT/SIGTERM exit zero, and startup or downstream fatal
 * failure exits nonzero with one sanitized event.
 */
export async function runServe(config, log) {
    let handle;
    let signaled = false;
    const onSignal = (code) => {
        if (signaled) {
            return;
        }
        signaled = true;
        log({ event: "shutdown", code });
        if (handle !== undefined) {
            void handle.shutdown(0);
        }
        else {
            process.exit(0);
        }
    };
    process.once("SIGINT", () => onSignal("sigint"));
    process.once("SIGTERM", () => onSignal("sigterm"));
    try {
        handle = await startGateway(config, log, {
            onExit: (code) => process.exit(code),
        });
    }
    catch (error) {
        const startupError = error instanceof StartupError ? error : new StartupError("startup_failed");
        log({
            event: "startup_failed",
            code: startupError.code,
            ...(startupError.sourceId === undefined ? {} : { sourceId: startupError.sourceId }),
        });
        process.exit(1);
    }
}
/**
 * Credential-free one-second liveness probe. Prints UP and exits 0 only when
 * status, headers, and the exact body match the frozen health contract.
 */
export async function runStatus() {
    try {
        const response = await fetch(`http://${GATEWAY_HOST}:${GATEWAY_PORT}${HEALTH_PATH}`, {
            signal: AbortSignal.timeout(1_000),
        });
        const body = await response.text();
        if (response.status === 200 &&
            response.headers.get("content-type") === "application/json" &&
            body === HEALTH_BODY) {
            process.stdout.write("UP\n");
            process.exitCode = 0;
            return;
        }
    }
    catch {
        // fall through to DOWN
    }
    process.stdout.write(`DOWN (log: ${logFilePath()})\n`);
    process.exitCode = 1;
}
function runCli() {
    const command = process.argv[2];
    if (command === "serve") {
        const log = createLogger(process.stdout, () => process.exit(1));
        let config;
        try {
            config = loadConfig(process.env);
        }
        catch (error) {
            const startupError = error instanceof StartupError ? error : new StartupError("startup_failed");
            log({
                event: "startup_failed",
                code: startupError.code,
                ...(startupError.sourceId === undefined ? {} : { sourceId: startupError.sourceId }),
            });
            process.exitCode = 1;
            return;
        }
        void runServe(config, log);
        return;
    }
    if (command === "status") {
        void runStatus();
        return;
    }
    process.stderr.write("Usage: cli.js serve|status\n");
    process.exitCode = 2;
}
if (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli();
}
