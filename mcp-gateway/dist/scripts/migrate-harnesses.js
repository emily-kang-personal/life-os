/**
 * Journaled migration of Codex (global) and Claude (user scope) from direct
 * Context7/Exa MCP registrations to the single gateway endpoint.
 *
 * Subcommands:
 *   plan                       read-only: discover direct entries, print actions
 *   apply                      snapshot, add gateway, verify + smoke, remove
 *                              direct entries; reverse-order rollback on failure
 *   restore --manifest FILE    replay a recorded migration in reverse
 *
 * Discovery is by exact URL identity against the configured source URLs, so
 * unrelated MCP registrations (OpenKnowledge etc.) are never touched.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GATEWAY_PORT, loadSources, sourcesFilePath } from "../src/config.js";
const GATEWAY_SERVER_NAME = "mcp-gateway";
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}/mcp`;
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const SOURCE_URLS = new Set(loadSources(sourcesFilePath()).map((s) => s.url));
/** Fixed read-only smoke calls, one per provider (args match live schemas). */
const SMOKE_CALLS = [
    {
        sourceId: "context7",
        tool: "resolve-library-id",
        args: { libraryName: "Node.js", query: "current LTS version" },
    },
    { sourceId: "exa", tool: "web_search_exa", args: { query: "Node.js current LTS version" } },
];
/** CLI-argument errors only; inside apply, THROW so the journal replays. */
function fail(message) {
    process.stderr.write(`migrate-harnesses: ${message}\n`);
    process.exit(1);
}
function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error !== undefined) {
        throw new Error(`failed to run ${command}: ${result.error.message}`);
    }
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}
function codexList() {
    const result = run("codex", ["mcp", "list", "--json"]);
    if (result.status !== 0) {
        throw new Error("codex mcp list --json failed");
    }
    return JSON.parse(result.stdout);
}
function claudeUserServers() {
    if (!existsSync(CLAUDE_CONFIG_PATH)) {
        throw new Error(`${CLAUDE_CONFIG_PATH} not found`);
    }
    const parsed = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, "utf8"));
    return parsed.mcpServers ?? {};
}
function discoverDirectEntries() {
    const entries = [];
    const seenUrls = new Map();
    for (const server of codexList()) {
        if (server.transport.url !== undefined && SOURCE_URLS.has(server.transport.url)) {
            const key = `codex:${server.transport.url}`;
            if (seenUrls.has(key)) {
                throw new Error(`ambiguous: codex has multiple entries for ${server.transport.url}`);
            }
            seenUrls.set(key, server.name);
            entries.push({
                harness: "codex",
                scope: "global",
                name: server.name,
                url: server.transport.url,
            });
        }
    }
    for (const [name, server] of Object.entries(claudeUserServers())) {
        if (server.url !== undefined && SOURCE_URLS.has(server.url)) {
            const key = `claude:${server.url}`;
            if (seenUrls.has(key)) {
                throw new Error(`ambiguous: claude has multiple entries for ${server.url}`);
            }
            seenUrls.set(key, name);
            entries.push({ harness: "claude", scope: "user", name, url: server.url });
        }
    }
    return entries;
}
// --- verification ------------------------------------------------------------
function verifyGatewayRegistered(harness) {
    if (harness === "codex") {
        const found = codexList().find((s) => s.name === GATEWAY_SERVER_NAME);
        if (found?.transport.url !== GATEWAY_URL) {
            throw new Error("codex does not show mcp-gateway after add");
        }
        return;
    }
    const entry = claudeUserServers()[GATEWAY_SERVER_NAME];
    if (entry?.url !== GATEWAY_URL) {
        throw new Error("claude user scope does not show mcp-gateway after add");
    }
}
function verifyRemoved(entry) {
    if (entry.harness === "codex") {
        if (codexList().some((s) => s.name === entry.name)) {
            throw new Error(`codex still shows ${entry.name} after removal`);
        }
        return;
    }
    if (Object.hasOwn(claudeUserServers(), entry.name)) {
        throw new Error(`claude user scope still shows ${entry.name} after removal`);
    }
}
/**
 * Proves each harness profile reaches exactly the gateway port: a sandboxed
 * probe must reach 47653 and must NOT reach a second loopback fixture port.
 * The gateway grant lives in the shared harness base profile these extend.
 * Runs top-level nono, so this must execute outside any sandbox.
 */
const FIXTURE_PORT = 47_799;
const DEFAULT_CLIENT_PROFILES = ["codex", "claude"];
async function verifyClientProfiles(profiles) {
    const fixture = createServer(() => { });
    await new Promise((resolve, reject) => {
        fixture.once("error", reject);
        fixture.listen(FIXTURE_PORT, "127.0.0.1", resolve);
    });
    try {
        for (const profile of profiles) {
            const probe = (port) => run("nono", [
                "run",
                "--silent",
                "--no-diagnostics",
                "--profile",
                profile,
                "--",
                process.execPath,
                "-e",
                `fetch('http://127.0.0.1:${port}/health',{signal:AbortSignal.timeout(2000)})` +
                    `.then((r)=>process.exit(r.status===200?0:1),()=>process.exit(1))`,
            ]).status;
            if (probe(GATEWAY_PORT) !== 0) {
                throw new Error(`profile ${profile} cannot reach the gateway on ${GATEWAY_PORT}`);
            }
            if (probe(FIXTURE_PORT) === 0) {
                throw new Error(`profile ${profile} reached fixture port ${FIXTURE_PORT}; isolation check failed`);
            }
            process.stdout.write(`client profile ok: ${profile}\n`);
        }
    }
    finally {
        fixture.close();
    }
}
async function smokeThroughGateway() {
    const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL));
    const client = new Client({ name: "migrate-harnesses", version: "0.1.0" });
    try {
        await client.connect(transport);
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((t) => t.name));
        for (const smoke of SMOKE_CALLS) {
            if (!names.has(smoke.tool)) {
                throw new Error(`gateway inventory is missing ${smoke.sourceId} tool ${smoke.tool}`);
            }
            const result = await client.callTool({ name: smoke.tool, arguments: smoke.args }, { timeout: 65_000 });
            if (result.isError === true) {
                const firstText = result.content.find((c) => c.type === "text");
                const detail = firstText?.type === "text" ? `: ${firstText.text.slice(0, 200)}` : "";
                throw new Error(`smoke call to ${smoke.tool} returned an error result${detail}`);
            }
            process.stdout.write(`smoke ok: ${smoke.sourceId} ${smoke.tool}\n`);
        }
    }
    finally {
        await client.close().catch(() => { });
    }
}
// --- mutations ---------------------------------------------------------------
function addGateway(harness, journal, manifestPath) {
    if (harness === "codex") {
        const existing = codexList().find((s) => s.name === GATEWAY_SERVER_NAME);
        if (existing !== undefined) {
            if (existing.transport.url === GATEWAY_URL) {
                process.stdout.write("codex already registers mcp-gateway; skipping add\n");
                return;
            }
            throw new Error("codex has a conflicting mcp-gateway entry");
        }
        const result = run("codex", ["mcp", "add", GATEWAY_SERVER_NAME, "--url", GATEWAY_URL]);
        if (result.status !== 0) {
            throw new Error("codex mcp add mcp-gateway failed");
        }
    }
    else {
        const existing = claudeUserServers()[GATEWAY_SERVER_NAME];
        if (existing !== undefined) {
            if (existing.url === GATEWAY_URL) {
                process.stdout.write("claude already registers mcp-gateway; skipping add\n");
                return;
            }
            throw new Error("claude has a conflicting mcp-gateway entry");
        }
        const result = run("claude", [
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "http",
            GATEWAY_SERVER_NAME,
            GATEWAY_URL,
        ]);
        if (result.status !== 0) {
            throw new Error("claude mcp add mcp-gateway failed");
        }
    }
    verifyGatewayRegistered(harness);
    recordMutation(journal, manifestPath, {
        kind: "added_gateway",
        harness,
        name: GATEWAY_SERVER_NAME,
        restoreArgv: harness === "codex"
            ? ["codex", "mcp", "remove", GATEWAY_SERVER_NAME]
            : ["claude", "mcp", "remove", "--scope", "user", GATEWAY_SERVER_NAME],
    });
}
function removeDirect(entry, journal, manifestPath) {
    const argv = entry.harness === "codex"
        ? ["codex", "mcp", "remove", entry.name]
        : ["claude", "mcp", "remove", "--scope", "user", entry.name];
    const result = run(argv[0], argv.slice(1));
    if (result.status !== 0) {
        throw new Error(`${argv.join(" ")} failed`);
    }
    verifyRemoved(entry);
    recordMutation(journal, manifestPath, {
        kind: "removed_direct",
        harness: entry.harness,
        name: entry.name,
        restoreArgv: entry.harness === "codex"
            ? ["codex", "mcp", "add", entry.name, "--url", entry.url]
            : [
                "claude",
                "mcp",
                "add",
                "--scope",
                "user",
                "--transport",
                "http",
                entry.name,
                entry.url,
            ],
    });
}
function recordMutation(journal, manifestPath, mutation) {
    journal.push(mutation);
    const manifest = { createdAt: new Date().toISOString(), mutations: journal };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
function replayReverse(mutations) {
    for (const mutation of [...mutations].reverse()) {
        const argv = mutation.restoreArgv;
        const result = run(argv[0], [...argv.slice(1)]);
        if (result.status !== 0) {
            process.stderr.write(`restore step failed: ${argv.join(" ")}\n`);
        }
        else {
            process.stdout.write(`restored: ${argv.join(" ")}\n`);
        }
    }
}
// --- modes -------------------------------------------------------------------
function planMode() {
    const entries = discoverDirectEntries();
    process.stdout.write("plan (read-only):\n");
    process.stdout.write(`  add ${GATEWAY_SERVER_NAME} -> ${GATEWAY_URL} (codex global, claude user)\n`);
    if (entries.length === 0) {
        process.stdout.write("  no direct Context7/Exa entries found; nothing to remove\n");
        return;
    }
    for (const entry of entries) {
        process.stdout.write(`  remove direct entry after smoke: ${entry.harness}/${entry.scope} ${entry.name} (${entry.url})\n`);
    }
}
async function applyMode(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { "client-profiles": { type: "string" } },
    });
    const clientProfiles = values["client-profiles"] === undefined
        ? DEFAULT_CLIENT_PROFILES
        : values["client-profiles"].split(",").map((name) => name.trim()).filter((n) => n !== "");
    const snapshotDir = mkdtempSync(join(tmpdir(), "mcp-gateway-migrate-"));
    chmodSync(snapshotDir, 0o700);
    const manifestPath = join(snapshotDir, "manifest.json");
    process.stdout.write(`snapshots + manifest: ${snapshotDir}\n`);
    // Snapshot both configurations and prove they parse before any mutation.
    const codexSnapshot = JSON.stringify(codexList(), null, 2);
    writeFileSync(join(snapshotDir, "codex-mcp-list.json"), codexSnapshot, { mode: 0o600 });
    const claudeSnapshot = JSON.stringify(claudeUserServers(), null, 2);
    writeFileSync(join(snapshotDir, "claude-user-mcp.json"), claudeSnapshot, { mode: 0o600 });
    JSON.parse(codexSnapshot);
    JSON.parse(claudeSnapshot);
    const before = discoverDirectEntries();
    const journal = [];
    try {
        addGateway("codex", journal, manifestPath);
        addGateway("claude", journal, manifestPath);
        await verifyClientProfiles(clientProfiles);
        await smokeThroughGateway();
        for (const entry of before) {
            removeDirect(entry, journal, manifestPath);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`apply failed: ${message}\n`);
        if (journal.length > 0) {
            process.stderr.write("replaying journal in reverse\n");
            replayReverse(journal);
        }
        process.exitCode = 1;
        return;
    }
    // Final normalized verification: only the expected entries changed.
    const remaining = discoverDirectEntries();
    if (remaining.length !== 0) {
        process.stderr.write("direct entries remain after migration; rolling back\n");
        replayReverse(journal);
        process.exit(1);
    }
    verifyGatewayRegistered("codex");
    verifyGatewayRegistered("claude");
    process.stdout.write(`migration complete; recovery manifest retained at ${manifestPath}\n`);
}
function restoreMode(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { manifest: { type: "string" } },
    });
    if (values.manifest === undefined) {
        fail("restore requires --manifest FILE");
    }
    const manifest = JSON.parse(readFileSync(values.manifest, "utf8"));
    replayReverse(manifest.mutations);
}
// pnpm forwards a literal "--" from `pnpm run script -- args`; drop it so
// parseArgs does not demote the following flags to positionals.
const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const mode = cliArgs[0];
try {
    if (mode === "plan") {
        planMode();
    }
    else if (mode === "apply") {
        await applyMode(cliArgs.slice(1));
    }
    else if (mode === "restore") {
        restoreMode(cliArgs.slice(1));
    }
    else {
        fail("usage: migrate-harnesses.js plan | apply [--client-profiles a,b] | restore --manifest FILE");
    }
}
catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}
