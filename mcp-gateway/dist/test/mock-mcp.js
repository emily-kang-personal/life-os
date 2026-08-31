import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, Server, } from "@modelcontextprotocol/server";
export function textResult(text) {
    return { content: [{ type: "text", text }] };
}
/**
 * Test listeners bind inside the fixed loopback range 47700-47799 granted by
 * the sandbox profile (ephemeral port 0 binds are not grantable narrowly).
 * Sequential allocation; collisions fail loudly at bind time.
 */
export const TEST_PORT_RANGE_START = 47_700;
export const TEST_PORT_RANGE_END = 47_799;
let nextTestPort = TEST_PORT_RANGE_START;
export function allocateLoopbackPort() {
    const port = nextTestPort;
    nextTestPort = nextTestPort >= TEST_PORT_RANGE_END ? TEST_PORT_RANGE_START : nextTestPort + 1;
    return port;
}
export async function startMockMcp(options = {}) {
    let tools = options.tools ?? [];
    let listRequests = 0;
    const calls = [];
    const seenHeaders = new Map();
    const mcpHandler = createMcpHandler(() => {
        const server = new Server({ name: "mock-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler("tools/list", (request) => {
            listRequests += 1;
            const pageSize = options.pageSize ?? Math.max(tools.length, 1);
            const cursor = request.params?.cursor;
            const start = cursor === undefined ? 0 : Number(cursor);
            const page = tools.slice(start, start + pageSize);
            const nextStart = start + pageSize;
            return nextStart < tools.length
                ? { tools: [...page], nextCursor: String(nextStart) }
                : { tools: [...page] };
        });
        server.setRequestHandler("tools/call", async (request, ctx) => {
            const record = {
                name: request.params.name,
                arguments: request.params.arguments,
                aborted: false,
            };
            calls.push(record);
            ctx.mcpReq.signal.addEventListener("abort", () => {
                record.aborted = true;
            });
            if (options.onCallTool !== undefined) {
                return options.onCallTool(request.params.name, request.params.arguments, ctx.mcpReq.signal);
            }
            return textResult(`echo:${request.params.name}`);
        });
        return server;
    });
    const nodeMcpHandler = toNodeHandler(mcpHandler);
    const httpServer = createServer((req, res) => {
        for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === "string") {
                seenHeaders.set(name, value);
            }
        }
        void (async () => {
            if (options.delayMs !== undefined) {
                await delay(options.delayMs);
            }
            if (options.mode === "refuse") {
                res.writeHead(500, { "content-type": "text/plain" });
                res.end("refused");
                return;
            }
            if (req.method === undefined || req.url === undefined) {
                res.writeHead(400).end();
                return;
            }
            await nodeMcpHandler(req, res);
        })().catch(() => {
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            else {
                res.end();
            }
        });
    });
    const port = allocateLoopbackPort();
    httpServer.listen(port, "127.0.0.1");
    await once(httpServer, "listening");
    return {
        url: `http://127.0.0.1:${port}/mcp`,
        port,
        calls,
        listRequests: () => listRequests,
        observedHeader: (name) => seenHeaders.get(name),
        setTools: (next) => {
            tools = next;
        },
        close: async () => {
            await mcpHandler.close().catch(() => { });
            httpServer.closeAllConnections();
            httpServer.close();
            await once(httpServer, "close");
        },
    };
}
