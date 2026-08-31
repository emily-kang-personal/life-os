/**
 * Single source of truth for gateway runtime constants and the source
 * registry. Source registrations are operator DATA, not code: they live in
 * sources.json at the project root (gitignored; see sources.example.json).
 * Deployment rendering and the harness migration read the same file, so the
 * gateway, the nono profile, and migration discovery can never drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const GATEWAY_HOST = "127.0.0.1";
export const GATEWAY_PORT = 47653;
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
export const CALL_TIMEOUT_MS = 60_000;
export const MAX_IN_FLIGHT_CALLS = 16;
export const STARTUP_TIMEOUT_MS = 15_000;
export const SHUTDOWN_DRAIN_MS = 10_000;
export const MAX_BODY_BYTES = 1_048_576;
/** Exact frozen health response body; tests byte-compare against this. */
export const HEALTH_BODY = '{"ok":true}';
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export function sourcesFilePath() {
    return join(PROJECT_ROOT, "sources.json");
}
/**
 * Sanitized startup/runtime failure. The message is always a stable code and
 * never carries URLs, headers, credential values, or downstream error text.
 */
export class StartupError extends Error {
    code;
    sourceId;
    constructor(code, sourceId) {
        super(code);
        this.name = "StartupError";
        this.code = code;
        this.sourceId = sourceId;
    }
}
function isNonEmptyString(value) {
    return typeof value === "string" && value !== "";
}
/**
 * Reads and strictly validates the source registry. Order in the file is the
 * deterministic discovery order. Fails closed with sanitized codes.
 */
export function loadSources(filePath) {
    let raw;
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch {
        throw new StartupError("missing_sources_file");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new StartupError("invalid_sources_file");
    }
    const sources = parsed.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new StartupError("invalid_sources_file");
    }
    const seenIds = new Set();
    const definitions = sources.map((entry) => {
        const candidate = entry;
        if (!isNonEmptyString(candidate.id) ||
            !isNonEmptyString(candidate.url) ||
            !isNonEmptyString(candidate.auth?.header) ||
            typeof candidate.auth?.prefix !== "string" ||
            !isNonEmptyString(candidate.credentialEnvVar) ||
            !isNonEmptyString(candidate.credentialRef)) {
            throw new StartupError("invalid_sources_file", isNonEmptyString(candidate.id) ? candidate.id : undefined);
        }
        try {
            const url = new URL(candidate.url);
            if (url.protocol !== "https:" && url.protocol !== "http:") {
                throw new Error("bad protocol");
            }
        }
        catch {
            throw new StartupError("invalid_sources_file", candidate.id);
        }
        if (seenIds.has(candidate.id)) {
            throw new StartupError("duplicate_source_id", candidate.id);
        }
        seenIds.add(candidate.id);
        return Object.freeze({
            id: candidate.id,
            url: candidate.url,
            auth: Object.freeze({ header: candidate.auth.header, prefix: candidate.auth.prefix }),
            credentialEnvVar: candidate.credentialEnvVar,
            credentialRef: candidate.credentialRef,
        });
    });
    return Object.freeze(definitions);
}
export function loadConfig(env) {
    const definitions = loadSources(sourcesFilePath());
    const sources = definitions.map((definition) => {
        const credential = env[definition.credentialEnvVar];
        if (credential === undefined || credential === "") {
            throw new StartupError("missing_credential_env", definition.id);
        }
        return Object.freeze({ ...definition, credential });
    });
    return Object.freeze({
        host: GATEWAY_HOST,
        port: GATEWAY_PORT,
        mcpPath: MCP_PATH,
        healthPath: HEALTH_PATH,
        callTimeoutMs: CALL_TIMEOUT_MS,
        maxInFlightCalls: MAX_IN_FLIGHT_CALLS,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        shutdownDrainMs: SHUTDOWN_DRAIN_MS,
        maxBodyBytes: MAX_BODY_BYTES,
        sources: Object.freeze(sources),
    });
}
