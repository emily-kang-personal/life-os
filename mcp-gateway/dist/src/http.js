import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { HEALTH_BODY } from "./config.js";
const PARSE_ERROR_BODY = '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}';
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" };
function deny(res, status, body, headers) {
    res.writeHead(status, { ...TEXT_HEADERS, ...headers });
    res.end(body);
}
function headerCount(req, name) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === name) {
            count += 1;
        }
    }
    return count;
}
/**
 * Request envelope guard, applied before any routing. Any present Origin
 * (including empty or duplicate) and any Host other than the exact configured
 * authority are rejected with a fixed 403; unknown raw targets get a fixed
 * 404. No denial exposes runtime, provider, or version details.
 */
export function validateRequestEnvelope(req, res, config) {
    if (headerCount(req, "origin") !== 0) {
        deny(res, 403, "Forbidden");
        return false;
    }
    const expectedHost = `${config.host}:${config.port}`;
    if (headerCount(req, "host") !== 1 || req.headers.host !== expectedHost) {
        deny(res, 403, "Forbidden");
        return false;
    }
    if (req.url !== config.mcpPath && req.url !== config.healthPath) {
        deny(res, 404, "Not found");
        return false;
    }
    return true;
}
/**
 * Streams at most maxBodyBytes, then parses UTF-8 JSON once. Oversize bodies
 * get a fixed 413 before the handler; malformed JSON gets the fixed standard
 * JSON-RPC Parse Error object with id null. Input is never reflected and no
 * method or payload translation happens at this seam.
 */
export function readBoundedJsonBody(req, res, maxBodyBytes) {
    return new Promise((resolve) => {
        const declared = req.headers["content-length"];
        if (declared !== undefined && Number(declared) > maxBodyBytes) {
            // Respond and discard the bounded remainder; destroying mid-upload
            // would RST and lose the 413 on the client side. Content-length
            // framing plus the server request timeout bound the drain.
            res.writeHead(413, TEXT_HEADERS);
            res.end("Payload too large");
            req.resume();
            resolve({ kind: "denied" });
            return;
        }
        const chunks = [];
        let received = 0;
        let settled = false;
        const settle = (outcome) => {
            if (!settled) {
                settled = true;
                resolve(outcome);
            }
        };
        req.on("data", (chunk) => {
            if (settled) {
                return;
            }
            received += chunk.byteLength;
            if (received > maxBodyBytes) {
                // No trustworthy length here, so stop the unbounded upload now;
                // flush the 413 first, accepting that the reset may outrun it.
                res.writeHead(413, TEXT_HEADERS);
                res.end("Payload too large", () => req.destroy());
                settle({ kind: "denied" });
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) {
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            }
            catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(PARSE_ERROR_BODY);
                settle({ kind: "denied" });
                return;
            }
            settle({ kind: "parsed", value: parsed });
        });
        req.on("error", () => {
            settle({ kind: "denied" });
        });
    });
}
/**
 * Builds the loopback HTTP server: envelope guard, frozen /health, and /mcp
 * delegation to the SDK handler with a pre-parsed bounded body. The caller
 * owns listen/close.
 */
export function createHttpServer(config, mcpHandler) {
    const nodeMcpHandler = toNodeHandler(mcpHandler);
    const server = createServer((req, res) => {
        res.sendDate = false;
        if (req.method === undefined || req.url === undefined) {
            deny(res, 400, "Bad request");
            return;
        }
        // Sound after the guard above; the SDK adapter requires a present method.
        const mcpReq = req;
        if (!validateRequestEnvelope(req, res, config)) {
            return;
        }
        if (req.url === config.healthPath) {
            if (req.method !== "GET") {
                deny(res, 405, "Method not allowed", { allow: "GET" });
                return;
            }
            res.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
            });
            res.end(HEALTH_BODY);
            return;
        }
        // Envelope guard guarantees req.url is the MCP path here.
        if (req.method === "POST") {
            void readBoundedJsonBody(req, res, config.maxBodyBytes).then((outcome) => {
                if (outcome.kind === "parsed") {
                    void nodeMcpHandler(mcpReq, res, outcome.value).catch(() => {
                        if (!res.headersSent) {
                            deny(res, 500, "Internal error");
                        }
                        else {
                            res.end();
                        }
                    });
                }
            });
            return;
        }
        void nodeMcpHandler(mcpReq, res).catch(() => {
            if (!res.headersSent) {
                deny(res, 500, "Internal error");
            }
            else {
                res.end();
            }
        });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    return server;
}
