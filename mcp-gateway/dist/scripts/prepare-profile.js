/**
 * Renders and validates the gateway's nono profile.
 *
 * Modes:
 *   prepare --output DIR ...   render-only into DIR (absent-or-identical writes)
 *   prepare --draft ...        write the profile draft, print the promote command
 *
 * The gateway is started MANUALLY from a terminal (see README) — deliberately
 * not supervised by launchd, so credentials can stay in 1Password and be
 * authorized interactively at start. There is no install mode.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadSources, sourcesFilePath } from "../src/config.js";
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_DIR = join(PROJECT_ROOT, "deploy");
const DRAFTS_DIR = join(homedir(), ".config", "nono", "profile-drafts");
const LOG_DIR = join(homedir(), "Library", "Logs", "life-os");
const PROFILE_FILENAME = "mcp-gateway.json";
function fail(message) {
    process.stderr.write(`prepare-profile: ${message}\n`);
    process.exit(1);
}
function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error !== undefined) {
        fail(`failed to run ${command}: ${result.error.message}`);
    }
    return { status: result.status ?? 1, stdout: result.stdout };
}
/**
 * Read grant covering the node binary for the sandbox profile. Seatbelt
 * matches resolved paths, and Homebrew's node is a symlink into a versioned
 * Cellar directory — grant the stable /opt/homebrew subtree there so brew
 * upgrades do not strand the profile; otherwise grant the binary's real
 * directory.
 */
function nodeReadPath(nodeBin) {
    if (nodeBin.startsWith("/opt/homebrew/")) {
        return "/opt/homebrew";
    }
    return dirname(realpathSync(nodeBin));
}
function renderTemplate(templateName, tokens) {
    let content = readFileSync(join(DEPLOY_DIR, templateName), "utf8");
    for (const [token, value] of Object.entries(tokens)) {
        content = content.replaceAll(`{{${token}}}`, value);
    }
    const leftover = content.match(/\{\{[A-Z_]+\}\}/);
    if (leftover !== null) {
        fail(`template ${templateName} has unrendered placeholder ${leftover[0]}`);
    }
    return content;
}
function renderProfile(inputs) {
    const rendered = renderTemplate("mcp-gateway.profile.template.json", {
        PROJECT_ROOT,
        NODE_READ_PATH: nodeReadPath(inputs.nodeBin),
    });
    // Credential routes are generated from the source registry so the profile
    // can never drift from what the gateway actually serves.
    const profile = JSON.parse(rendered);
    profile.network.credentials = inputs.sources.map((source) => source.id);
    profile.network.custom_credentials = Object.fromEntries(inputs.sources.map((source) => {
        const url = new URL(source.url);
        return [
            source.id,
            {
                upstream: url.origin,
                credential_key: source.credentialRef,
                env_var: source.credentialEnvVar,
                inject_header: source.auth.header,
                credential_format: `${source.auth.prefix}{}`,
                endpoint_rules: [{ method: "*", path: url.pathname }],
            },
        ];
    }));
    return JSON.stringify(profile, null, 2) + "\n";
}
function validateProfile(content) {
    const scratch = mkdtempSync(join(tmpdir(), "mcp-gateway-validate-"));
    chmodSync(scratch, 0o700);
    try {
        const path = join(scratch, PROFILE_FILENAME);
        writeFileSync(path, content, { mode: 0o600 });
        const result = run("nono", ["profile", "validate", "--strict", "--silent", path]);
        if (result.status !== 0) {
            fail(`nono profile validate --strict rejected ${PROFILE_FILENAME}`);
        }
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
/** Writes only when absent or byte-identical; a differing existing file fails. */
function writeAbsentOrIdentical(path, content) {
    if (existsSync(path)) {
        const existing = readFileSync(path, "utf8");
        if (existing === content) {
            return "identical";
        }
        fail(`${path} exists with different content; refusing to overwrite`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
    return "written";
}
function prepare(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            output: { type: "string" },
            draft: { type: "boolean" },
            "node-bin": { type: "string" },
        },
    });
    const outputDir = values.output;
    const draft = values.draft === true;
    if ((outputDir !== undefined) === draft) {
        fail("prepare requires exactly one of --output DIR or --draft");
    }
    const nodeBin = values["node-bin"] ?? process.execPath;
    if (!existsSync(nodeBin)) {
        fail(`--node-bin ${nodeBin} does not exist`);
    }
    const sources = loadSources(sourcesFilePath());
    const profile = renderProfile({ nodeBin, sources });
    validateProfile(profile);
    if (outputDir !== undefined) {
        mkdirSync(outputDir, { recursive: true });
        const outcome = writeAbsentOrIdentical(join(outputDir, PROFILE_FILENAME), profile);
        process.stdout.write(`${outcome}: ${join(outputDir, PROFILE_FILENAME)}\n`);
        return;
    }
    // Draft mode: owner-only log directory, profile draft, promote command.
    if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    }
    const outcome = writeAbsentOrIdentical(join(DRAFTS_DIR, PROFILE_FILENAME), profile);
    process.stdout.write(`${outcome}: ${join(DRAFTS_DIR, PROFILE_FILENAME)}\n`);
    // When updating an existing active profile, nono profile promote requires
    // a .base file carrying the SHA-256 of the active profile's current bytes.
    const activePath = join(homedir(), ".config", "nono", "profiles", PROFILE_FILENAME);
    if (existsSync(activePath)) {
        const baseHash = createHash("sha256").update(readFileSync(activePath)).digest("hex");
        writeFileSync(join(DRAFTS_DIR, "mcp-gateway.base"), `${baseHash}\n`, { mode: 0o600 });
        process.stdout.write(`written: ${join(DRAFTS_DIR, "mcp-gateway.base")}\n`);
    }
    process.stdout.write("\nReview the draft above, then promote it:\n" +
        "  nono profile promote mcp-gateway\n" +
        "\nThen start the gateway manually (see README): pnpm gateway:serve\n");
}
// pnpm forwards a literal "--" from `pnpm run script -- args`; drop it so
// parseArgs does not demote the following flags to positionals.
const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const mode = cliArgs[0];
if (mode === "prepare") {
    prepare(cliArgs.slice(1));
}
else {
    fail("usage: prepare-profile.js prepare (--output DIR | --draft) OPTIONS...");
}
