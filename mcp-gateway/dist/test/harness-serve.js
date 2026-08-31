/**
 * Spawnable entry for process-level tests. Builds a GatewayConfig pointing at
 * mock downstreams supplied via environment variables, then runs the REAL
 * runServe wiring (signal handlers, exit codes, stdout JSONL) so process
 * invariants exercise production code, not a test re-implementation.
 */
import { runServe } from "../src/cli.js";
import { createLogger } from "../src/logger.js";
function requireEnv(name) {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`harness requires ${name}`);
    }
    return value;
}
const config = {
    host: "127.0.0.1",
    port: Number(requireEnv("GATEWAY_TEST_PORT")),
    mcpPath: "/mcp",
    healthPath: "/health",
    callTimeoutMs: Number(process.env["GATEWAY_TEST_CALL_TIMEOUT_MS"] ?? "60000"),
    maxInFlightCalls: 16,
    startupTimeoutMs: Number(process.env["GATEWAY_TEST_STARTUP_TIMEOUT_MS"] ?? "5000"),
    shutdownDrainMs: Number(process.env["GATEWAY_TEST_DRAIN_MS"] ?? "1000"),
    maxBodyBytes: 1_048_576,
    sources: [
        {
            id: "context7",
            url: requireEnv("GATEWAY_TEST_C7_URL"),
            auth: { header: "authorization", prefix: "Bearer " },
            credential: "SENTINEL_SECRET_C7",
            credentialEnvVar: "CONTEXT7_API_KEY",
            credentialRef: "op://test/context7/credential",
        },
        {
            id: "exa",
            url: requireEnv("GATEWAY_TEST_EXA_URL"),
            auth: { header: "x-api-key", prefix: "" },
            credential: "SENTINEL_SECRET_EXA",
            credentialEnvVar: "EXA_API_KEY",
            credentialRef: "op://test/exa/credential",
        },
    ],
};
void runServe(config, createLogger(process.stdout, () => process.exit(1)));
