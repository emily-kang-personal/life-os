import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport, } from "@modelcontextprotocol/client";
import { allocateLoopbackPort, startMockMcp, textResult, } from "./mock-mcp.js";
import { startGateway } from "../src/cli.js";
import { connectDownstreams } from "../src/downstreams.js";
import { createLogger } from "../src/logger.js";
import { StartupError, loadSources } from "../src/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const HARNESS_PATH = join(dirname(fileURLToPath(import.meta.url)), "harness-serve.js");
function tool(name, extra = {}) {
    return {
        name,
        description: `${name} description`,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        ...extra,
    };
}
async function getFreePort() {
    return allocateLoopbackPort();
}
function testConfig(port, c7Url, exaUrl, overrides = {}) {
    return {
        host: "127.0.0.1",
        port,
        mcpPath: "/mcp",
        healthPath: "/health",
        callTimeoutMs: 60_000,
        maxInFlightCalls: 16,
        startupTimeoutMs: 5_000,
        shutdownDrainMs: 1_000,
        maxBodyBytes: 1_048_576,
        sources: [
            {
                id: "context7",
                url: c7Url,
                auth: { header: "authorization", prefix: "Bearer " },
                credential: "SENTINEL_SECRET_C7",
                credentialEnvVar: "CONTEXT7_API_KEY",
                credentialRef: "op://test/context7/credential",
            },
            {
                id: "exa",
                url: exaUrl,
                auth: { header: "x-api-key", prefix: "" },
                credential: "SENTINEL_SECRET_EXA",
                credentialEnvVar: "EXA_API_KEY",
                credentialRef: "op://test/exa/credential",
            },
        ],
        ...overrides,
    };
}
const noopLog = createLogger(new PassThrough(), () => { });
async function startTestGateway(opts = {}) {
    const c7 = await startMockMcp({
        tools: [tool("c7_resolve"), tool("c7_docs")],
        ...opts.c7,
    });
    const exa = await startMockMcp({ tools: [tool("exa_search")], ...opts.exa });
    const port = await getFreePort();
    const config = testConfig(port, c7.url, exa.url, opts.config);
    const stream = new PassThrough();
    let captured = "";
    stream.on("data", (chunk) => {
        captured += String(chunk);
    });
    const log = createLogger(stream, () => { });
    const exitCodes = [];
    let handle;
    try {
        handle = await startGateway(config, log, {
            onExit: (code) => {
                exitCodes.push(code);
            },
        });
    }
    catch (error) {
        await c7.close();
        await exa.close();
        throw error;
    }
    return {
        config,
        port,
        url: `http://127.0.0.1:${port}`,
        handle,
        c7,
        exa,
        exitCodes,
        logText: () => captured,
        events: () => captured
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line)),
        close: async () => {
            await handle.shutdown(0);
            await c7.close();
            await exa.close();
        },
    };
}
async function connectClient(gatewayUrl) {
    const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`));
    // Modern-era negotiation, so caller cancellation reaches the gateway's
    // per-request signal; the dedicated legacy test covers the 2025 path.
    const client = new Client({ name: "test-client", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    return client;
}
/** Raw HTTP exchange for header shapes fetch cannot produce. */
async function rawRequest(port, requestText) {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    // The server may reset mid-upload after answering (413 paths); keep
    // whatever was received rather than failing on the reset. events.once
    // would reject on 'error', so wait for 'close' manually.
    socket.on("error", () => { });
    socket.write(requestText);
    let data = "";
    socket.on("data", (chunk) => {
        data += String(chunk);
    });
    await new Promise((resolve) => {
        socket.on("close", () => resolve());
    });
    return data;
}
function rawLines(lines) {
    return lines.join("\r\n") + "\r\n\r\n";
}
async function waitFor(predicate, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("waitFor timeout");
        }
        await delay(20);
    }
}
// ---------------------------------------------------------------------------
test("source registry parses strictly and fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "sources-test-"));
    const write = (name, content) => {
        const path = join(dir, name);
        writeFileSync(path, content);
        return path;
    };
    const valid = write("valid.json", JSON.stringify({
        sources: [
            {
                id: "alpha",
                url: "https://alpha.example/mcp",
                auth: { header: "Authorization", prefix: "Bearer " },
                credentialEnvVar: "ALPHA_KEY",
                credentialRef: "op://v/i/f",
            },
        ],
    }));
    const parsed = loadSources(valid);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, "alpha");
    assert.equal(parsed[0]?.auth.prefix, "Bearer ");
    const cases = [
        ["missing", join(dir, "nope.json"), "missing_sources_file"],
        ["not json", write("bad.json", "{nope"), "invalid_sources_file"],
        ["empty list", write("empty.json", '{"sources":[]}'), "invalid_sources_file"],
        [
            "missing field",
            write("field.json", '{"sources":[{"id":"a","url":"https://x.example/mcp"}]}'),
            "invalid_sources_file",
        ],
        [
            "bad url",
            write("url.json", JSON.stringify({
                sources: [
                    {
                        id: "a",
                        url: "ftp://x.example/mcp",
                        auth: { header: "h", prefix: "" },
                        credentialEnvVar: "K",
                        credentialRef: "op://v/i/f",
                    },
                ],
            })),
            "invalid_sources_file",
        ],
        [
            "duplicate id",
            write("dup.json", JSON.stringify({
                sources: [
                    {
                        id: "a",
                        url: "https://x.example/mcp",
                        auth: { header: "h", prefix: "" },
                        credentialEnvVar: "K",
                        credentialRef: "op://v/i/f",
                    },
                    {
                        id: "a",
                        url: "https://y.example/mcp",
                        auth: { header: "h", prefix: "" },
                        credentialEnvVar: "K2",
                        credentialRef: "op://v/i/g",
                    },
                ],
            })),
            "duplicate_source_id",
        ],
    ];
    for (const [label, path, code] of cases) {
        assert.throws(() => loadSources(path), (error) => error instanceof StartupError && error.code === code, label);
    }
});
test("binds IPv4 loopback only", async () => {
    const gw = await startTestGateway();
    try {
        const response = await fetch(`${gw.url}/health`);
        assert.equal(response.status, 200);
        let v6Connected = false;
        try {
            const socket = net.connect({ host: "::1", port: gw.port });
            await once(socket, "connect");
            v6Connected = true;
            socket.destroy();
        }
        catch {
            // refused as required
        }
        assert.equal(v6Connected, false, "IPv6 loopback must not be reachable");
    }
    finally {
        await gw.close();
    }
});
test("any present Origin is denied with 403 before routing", async () => {
    const gw = await startTestGateway();
    try {
        for (const origin of [
            "https://example.com",
            `http://127.0.0.1:${gw.port}`,
            "null",
            "localhost",
        ]) {
            for (const path of ["/health", "/mcp"]) {
                const response = await fetch(`${gw.url}${path}`, {
                    method: path === "/mcp" ? "POST" : "GET",
                    headers: { origin, "content-type": "application/json" },
                    ...(path === "/mcp" ? { body: "{}" } : {}),
                });
                assert.equal(response.status, 403, `origin=${origin} path=${path}`);
            }
        }
        // Empty and duplicate Origin need a raw socket.
        const emptyOrigin = await rawRequest(gw.port, rawLines([
            "GET /health HTTP/1.1",
            `Host: 127.0.0.1:${gw.port}`,
            "Origin:",
            "Connection: close",
        ]));
        assert.match(emptyOrigin, /^HTTP\/1\.1 403 /);
        const duplicateOrigin = await rawRequest(gw.port, rawLines([
            "GET /health HTTP/1.1",
            `Host: 127.0.0.1:${gw.port}`,
            "Origin: https://a.example",
            "Origin: https://b.example",
            "Connection: close",
        ]));
        assert.match(duplicateOrigin, /^HTTP\/1\.1 403 /);
    }
    finally {
        await gw.close();
    }
});
test("Host must be exactly the configured authority", async () => {
    const gw = await startTestGateway();
    try {
        for (const host of [
            `localhost:${gw.port}`,
            "127.0.0.1:9999",
            "127.0.0.1",
            "evil.example",
            `attacker.example:${gw.port}`,
        ]) {
            const response = await rawRequest(gw.port, rawLines(["GET /health HTTP/1.1", `Host: ${host}`, "Connection: close"]));
            assert.match(response, /^HTTP\/1\.1 403 /, `host=${host}`);
        }
        const duplicateHost = await rawRequest(gw.port, rawLines([
            "GET /health HTTP/1.1",
            `Host: 127.0.0.1:${gw.port}`,
            `Host: 127.0.0.1:${gw.port}`,
            "Connection: close",
        ]));
        // Node may pre-empt duplicate Host with its own 400; either way, never 200.
        assert.match(duplicateHost, /^HTTP\/1\.1 4\d\d /);
        const missingHost = await rawRequest(gw.port, rawLines(["GET /health HTTP/1.0", "Connection: close"]));
        assert.match(missingHost, /^HTTP\/1\.[01] 4\d\d /);
        for (const target of ["/health?x=1", "/mcp/", "/mcp?y=2", "/unknown", "//health"]) {
            const response = await rawRequest(gw.port, rawLines([
                `GET ${target} HTTP/1.1`,
                `Host: 127.0.0.1:${gw.port}`,
                "Connection: close",
            ]));
            assert.match(response, /^HTTP\/1\.1 404 /, `target=${target}`);
        }
    }
    finally {
        await gw.close();
    }
});
test("MCP bodies are bounded at 1 MiB with recovery", async () => {
    const gw = await startTestGateway();
    try {
        const oversized = `{"pad":"${"x".repeat(1_048_576)}"}`;
        const declared = await rawRequest(gw.port, rawLines([
            "POST /mcp HTTP/1.1",
            `Host: 127.0.0.1:${gw.port}`,
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(oversized)}`,
            "Connection: close",
        ]) + oversized);
        assert.match(declared, /^HTTP\/1\.1 413 /);
        // Chunked upload with no declared length must be stopped mid-stream.
        const socket = net.connect(gw.port, "127.0.0.1");
        await once(socket, "connect");
        socket.write(rawLines([
            "POST /mcp HTTP/1.1",
            `Host: 127.0.0.1:${gw.port}`,
            "Content-Type: application/json",
            "Transfer-Encoding: chunked",
            "Connection: close",
        ]));
        const chunk = "y".repeat(65_536);
        for (let i = 0; i < 20; i += 1) {
            socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        }
        let chunkedResponse = "";
        socket.on("data", (piece) => {
            chunkedResponse += String(piece);
        });
        socket.on("error", () => { });
        await new Promise((resolve) => {
            socket.on("close", () => resolve());
        });
        // Mid-stream termination is deliberate here; the reset can outrun the
        // 413, so the invariant is "terminated without processing", not the
        // status line itself.
        assert.ok(chunkedResponse === "" || /^HTTP\/1\.1 413 /.test(chunkedResponse), `unexpected chunked response: ${chunkedResponse.slice(0, 40)}`);
        // The gateway recovers for the next request.
        const health = await fetch(`${gw.url}/health`);
        assert.equal(health.status, 200);
    }
    finally {
        await gw.close();
    }
});
test("malformed JSON gets the fixed Parse Error and nothing reflected", async () => {
    const gw = await startTestGateway();
    try {
        const body = "{not json SENTINEL_REFLECT";
        const response = await fetch(`${gw.url}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        assert.equal(response.status, 400);
        const text = await response.text();
        assert.equal(text, '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}');
    }
    finally {
        await gw.close();
    }
});
test("health is exact and cannot drift", async () => {
    const gw = await startTestGateway();
    try {
        const response = await fetch(`${gw.url}/health`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '{"ok":true}');
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("server"), null);
        assert.equal(response.headers.get("x-powered-by"), null);
        assert.equal(response.headers.get("date"), null);
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
            const denied = await fetch(`${gw.url}/health`, { method });
            assert.equal(denied.status, 405, method);
            assert.equal(denied.headers.get("allow"), "GET");
        }
    }
    finally {
        await gw.close();
    }
});
test("native tool definitions and results pass through unchanged", async () => {
    const richTool = tool("c7_resolve", {
        title: "Rich tool",
        inputSchema: {
            type: "object",
            properties: {
                q: { type: "string", description: "query" },
                opts: {
                    type: "object",
                    properties: { depth: { type: "integer", minimum: 0 } },
                },
            },
            required: ["q"],
        },
        annotations: { readOnlyHint: true, title: "Annotated" },
        _meta: { "example.com/custom": { nested: [1, 2, 3] } },
    });
    const richResult = {
        content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world", _meta: { block: true } },
        ],
        structuredContent: { items: [{ id: 1 }, { id: 2 }] },
        _meta: { "example.com/result": "yes" },
    };
    const gw = await startTestGateway({
        c7: {
            tools: [richTool, tool("c7_docs")],
            onCallTool: () => richResult,
        },
    });
    const client = await connectClient(gw.url);
    try {
        const listed = await client.listTools();
        const received = listed.tools.find((t) => t.name === "c7_resolve");
        assert.deepEqual(JSON.parse(JSON.stringify(received)), JSON.parse(JSON.stringify(richTool)));
        const result = await client.callTool({
            name: "c7_resolve",
            arguments: { q: "hi" },
        });
        // The SDK's modern-era encode seam stamps reserved
        // io.modelcontextprotocol/* envelope keys into result._meta on every
        // response; those belong to the protocol layer, not the gateway, so
        // strip only that namespace before asserting byte-level passthrough.
        const normalized = JSON.parse(JSON.stringify(result));
        for (const key of Object.keys(normalized._meta ?? {})) {
            if (key.startsWith("io.modelcontextprotocol/")) {
                delete normalized._meta?.[key];
            }
        }
        assert.deepEqual(normalized, JSON.parse(JSON.stringify(richResult)));
        const recorded = gw.c7.calls[0];
        assert.deepEqual(recorded?.arguments, { q: "hi" });
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("paginated downstream inventories are fully aggregated", async () => {
    const gw = await startTestGateway({
        c7: {
            tools: [tool("c7_a"), tool("c7_b"), tool("c7_c")],
            pageSize: 1,
        },
    });
    const client = await connectClient(gw.url);
    try {
        const listed = await client.listTools();
        const names = listed.tools.map((t) => t.name).sort();
        assert.deepEqual(names, ["c7_a", "c7_b", "c7_c", "exa_search"]);
        assert.ok(gw.c7.listRequests() >= 3, "expected one request per page");
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("duplicate native tool names fail startup before bind", async () => {
    const c7 = await startMockMcp({ tools: [tool("dup_tool")] });
    const exa = await startMockMcp({ tools: [tool("dup_tool")] });
    const port = await getFreePort();
    try {
        await assert.rejects(startGateway(testConfig(port, c7.url, exa.url), noopLog, { onExit: () => { } }), (error) => error instanceof StartupError && error.code === "duplicate_tool_name");
        await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    }
    finally {
        await c7.close();
        await exa.close();
    }
});
test("empty downstream inventory fails startup", async () => {
    const c7 = await startMockMcp({ tools: [tool("c7_a")] });
    const exa = await startMockMcp({ tools: [] });
    const port = await getFreePort();
    try {
        await assert.rejects(startGateway(testConfig(port, c7.url, exa.url), noopLog, { onExit: () => { } }), (error) => error instanceof StartupError &&
            error.code === "empty_tool_inventory" &&
            error.sourceId === "exa");
    }
    finally {
        await c7.close();
        await exa.close();
    }
});
test("downstream connect failure aborts startup with a sanitized error", async () => {
    const c7 = await startMockMcp({ tools: [tool("c7_a")] });
    const exa = await startMockMcp({ mode: "refuse" });
    const port = await getFreePort();
    try {
        await assert.rejects(startGateway(testConfig(port, c7.url, exa.url), noopLog, { onExit: () => { } }), (error) => error instanceof StartupError &&
            error.code === "downstream_connect_failed" &&
            error.sourceId === "exa");
        await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    }
    finally {
        await c7.close();
        await exa.close();
    }
});
test("inventory changes only on restart", async () => {
    const gw = await startTestGateway();
    try {
        gw.c7.setTools([tool("c7_added_later")]);
        const client = await connectClient(gw.url);
        const listed = await client.listTools();
        await client.close();
        assert.deepEqual(listed.tools.map((t) => t.name).sort(), ["c7_docs", "c7_resolve", "exa_search"]);
        // A restart picks up the new inventory.
        const newPort = await getFreePort();
        const restarted = await startGateway(testConfig(newPort, gw.c7.url, gw.exa.url), noopLog, { onExit: () => { } });
        const client2 = await connectClient(`http://127.0.0.1:${newPort}`);
        const relisted = await client2.listTools();
        await client2.close();
        await restarted.shutdown(0);
        assert.deepEqual(relisted.tools.map((t) => t.name).sort(), ["c7_added_later", "exa_search"]);
    }
    finally {
        await gw.close();
    }
});
test("unknown tool names are rejected without downstream invocation", async () => {
    const gw = await startTestGateway();
    const client = await connectClient(gw.url);
    try {
        await assert.rejects(client.callTool({ name: "no_such_tool", arguments: {} }));
        assert.equal(gw.c7.calls.length, 0);
        assert.equal(gw.exa.calls.length, 0);
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("calls time out with no retry and cancellation reaches the downstream", async () => {
    const gw = await startTestGateway({
        exa: {
            tools: [tool("exa_search")],
            onCallTool: (_name, _args, signal) => new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve(textResult("late")));
            }),
        },
        config: { callTimeoutMs: 300 },
    });
    const client = await connectClient(gw.url);
    try {
        const result = await client.callTool({ name: "exa_search", arguments: { q: "x" } });
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: "Gateway timeout" }]);
        assert.equal(gw.exa.calls.length, 1, "no retry");
        await waitFor(() => gw.exa.calls[0]?.aborted === true);
        const events = gw.events();
        const end = events.find((e) => e["event"] === "call_end");
        assert.equal(end?.["outcome"], "timeout");
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("caller cancellation propagates and the gateway stays healthy", async () => {
    const gw = await startTestGateway({
        exa: {
            tools: [tool("exa_search")],
            onCallTool: (_name, _args, signal) => new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve(textResult("late")));
            }),
        },
    });
    const client = await connectClient(gw.url);
    try {
        const controller = new AbortController();
        // requestSignal tears down the POST itself, which is how a caller's
        // cancellation becomes visible to the gateway's per-request signal.
        const pending = client.callTool({ name: "exa_search", arguments: {} }, { signal: controller.signal, requestSignal: controller.signal });
        await waitFor(() => gw.exa.calls.length === 1);
        controller.abort();
        await assert.rejects(pending);
        await waitFor(() => gw.exa.calls[0]?.aborted === true);
        const health = await fetch(`${gw.url}/health`);
        assert.equal(health.status, 200);
        await waitFor(() => gw.events().some((e) => e["event"] === "call_end" && e["outcome"] === "cancelled"));
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("capacity is bounded at 16 in-flight calls with no queue", async () => {
    const releases = [];
    const gw = await startTestGateway({
        exa: {
            tools: [tool("exa_search")],
            onCallTool: (_name, _args, signal) => new Promise((resolve) => {
                releases.push(() => resolve(textResult("released")));
                signal.addEventListener("abort", () => resolve(textResult("aborted")));
            }),
        },
    });
    const client = await connectClient(gw.url);
    try {
        const held = Array.from({ length: 16 }, () => client.callTool({ name: "exa_search", arguments: {} }));
        await waitFor(() => gw.exa.calls.length === 16);
        const seventeenth = await client.callTool({ name: "exa_search", arguments: {} });
        assert.equal(seventeenth.isError, true);
        assert.deepEqual(seventeenth.content, [{ type: "text", text: "Gateway busy" }]);
        assert.equal(gw.exa.calls.length, 16, "no downstream invocation for the 17th");
        for (const release of releases) {
            release();
        }
        const settled = await Promise.all(held);
        for (const result of settled) {
            assert.notEqual(result.isError, true);
        }
        const afterPromise = client.callTool({ name: "exa_search", arguments: {} });
        await waitFor(() => gw.exa.calls.length === 17);
        releases.at(-1)?.();
        const after = await afterPromise;
        assert.notEqual(after.isError, true);
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("unexpected downstream loss after ready is fatal exactly once", async () => {
    const c7 = await startMockMcp({ tools: [tool("c7_a")] });
    const exa = await startMockMcp({ tools: [tool("exa_a")] });
    const port = await getFreePort();
    const config = testConfig(port, c7.url, exa.url);
    try {
        // Deliberate close before ready: no fatal.
        const fatalsA = [];
        const registryA = await connectDownstreams(config, (code, sourceId) => fatalsA.push(`${code}:${sourceId}`));
        await registryA.close();
        assert.deepEqual(fatalsA, []);
        // Unexpected close after ready: fatal once; deliberate close adds nothing.
        const fatalsB = [];
        const registryB = await connectDownstreams(config, (code, sourceId) => fatalsB.push(`${code}:${sourceId}`));
        registryB.markReady();
        await registryB.handles()[1]?.client.close();
        await waitFor(() => fatalsB.length > 0);
        assert.deepEqual(fatalsB, ["downstream_closed:exa"]);
        await registryB.close();
        assert.deepEqual(fatalsB, ["downstream_closed:exa"]);
    }
    finally {
        await c7.close();
        await exa.close();
    }
});
test("JSONL is metadata-only: sentinels never reach the log", async () => {
    const gw = await startTestGateway({
        exa: {
            tools: [tool("exa_search")],
            onCallTool: () => textResult("SENTINEL_RESULT"),
        },
    });
    const client = await connectClient(gw.url);
    try {
        await client.callTool({
            name: "exa_search",
            arguments: { q: "SENTINEL_ARGUMENT" },
        });
        await assert.rejects(client.callTool({ name: "SENTINEL_UNKNOWN_%", arguments: {} }));
        const text = gw.logText();
        for (const forbidden of [
            "SENTINEL_SECRET",
            "SENTINEL_ARGUMENT",
            "SENTINEL_RESULT",
            "Bearer",
            "http://",
            "https://",
        ]) {
            assert.ok(!text.includes(forbidden), `log must not contain ${forbidden}`);
        }
        const allowedKeys = new Set([
            "ts",
            "level",
            "event",
            "requestId",
            "sourceId",
            "tool",
            "outcome",
            "durationMs",
            "code",
            "reason",
        ]);
        for (const line of text.split("\n").filter((l) => l !== "")) {
            const parsed = JSON.parse(line);
            for (const key of Object.keys(parsed)) {
                assert.ok(allowedKeys.has(key), `unexpected log key ${key}`);
            }
        }
        // The unknown-tool denial must not log the requested name.
        assert.ok(!text.includes("SENTINEL_UNKNOWN"));
    }
    finally {
        await client.close();
        await gw.close();
    }
});
test("legacy 2025-era clients are served through the stateless path", async () => {
    const gw = await startTestGateway();
    try {
        const post = async (body) => {
            const response = await fetch(`${gw.url}/mcp`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 200);
            const text = await response.text();
            const contentType = response.headers.get("content-type") ?? "";
            if (contentType.includes("text/event-stream")) {
                const dataLine = text
                    .split("\n")
                    .find((line) => line.startsWith("data:"));
                assert.ok(dataLine !== undefined, "SSE response must carry a data line");
                return JSON.parse(dataLine.slice(5));
            }
            return JSON.parse(text);
        };
        const initialize = (await post({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "legacy-test", version: "0.0.0" },
            },
        }));
        assert.ok(initialize.result?.protocolVersion !== undefined);
        const listed = (await post({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
        }));
        const names = (listed.result?.tools ?? []).map((t) => t.name).sort();
        assert.deepEqual(names, ["c7_docs", "c7_resolve", "exa_search"]);
    }
    finally {
        await gw.close();
    }
});
async function spawnHarness(env) {
    const child = spawn(process.execPath, [HARNESS_PATH], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
    });
    const done = new Promise((resolve) => {
        child.on("exit", (code) => resolve({ code, stdout }));
    });
    return { child, done, stdout: () => stdout };
}
test("process: startup failure exits nonzero and never listens", async () => {
    const c7 = await startMockMcp({ mode: "refuse" });
    const exa = await startMockMcp({ mode: "refuse" });
    const port = await getFreePort();
    try {
        const harness = await spawnHarness({
            GATEWAY_TEST_PORT: String(port),
            GATEWAY_TEST_C7_URL: c7.url,
            GATEWAY_TEST_EXA_URL: exa.url,
            GATEWAY_TEST_STARTUP_TIMEOUT_MS: "3000",
        });
        const result = await harness.done;
        assert.equal(result.code, 1);
        assert.ok(!result.stdout.includes('"ready"'), "must never report ready");
        const failure = result.stdout
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l))
            .find((e) => e["event"] === "startup_failed");
        assert.ok(failure !== undefined);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    }
    finally {
        await c7.close();
        await exa.close();
    }
});
test("process: SIGTERM drains and exits zero; no child processes", async () => {
    const c7 = await startMockMcp({ tools: [tool("c7_a")] });
    const exa = await startMockMcp({ tools: [tool("exa_a")] });
    const port = await getFreePort();
    try {
        const harness = await spawnHarness({
            GATEWAY_TEST_PORT: String(port),
            GATEWAY_TEST_C7_URL: c7.url,
            GATEWAY_TEST_EXA_URL: exa.url,
        });
        const deadline = Date.now() + 5_000;
        let up = false;
        while (!up && Date.now() < deadline) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/health`, {
                    signal: AbortSignal.timeout(500),
                });
                up = response.status === 200;
            }
            catch {
                await delay(50);
            }
        }
        assert.ok(up, "gateway did not come up");
        // The gateway spawns no children.
        const pgrep = spawn("pgrep", ["-P", String(harness.child.pid)]);
        let children = "";
        pgrep.stdout.on("data", (chunk) => {
            children += String(chunk);
        });
        await new Promise((resolve) => pgrep.on("exit", resolve));
        assert.equal(children.trim(), "");
        harness.child.kill("SIGTERM");
        const result = await harness.done;
        assert.equal(result.code, 0);
        assert.ok(result.stdout.includes('"ready"'));
        assert.ok(result.stdout.includes('"shutdown"'));
        await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
    }
    finally {
        await c7.close();
        await exa.close();
    }
});
