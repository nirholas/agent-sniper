#!/usr/bin/env node
// agent-sniper — command-line entry for @three-ws/agent-sniper.
//
// One binary, five faces: `run` (live/simulate trade loop), `mcp` (stdio MCP
// server), `serve` (x402 paid HTTP API), `arm` (strategy template/validator,
// no network), and `status` (local config or a remote /status probe). The hard
// dependencies are the local package + Node builtins only — the arg parser is
// hand-rolled and the heavier faces (mcp/api/sqlite) are imported lazily so a
// minimal `arm`/`help` run never touches them.
//
// SAFETY: the default mode is `simulate`. `live` trades REAL funds from the
// agent wallet and must be opted into explicitly with `--mode live`.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	presets,
	loadConfig,
	createSelfCustodyWallet,
	createMemoryStore,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── tiny flag parser ────────────────────────────────────────────────────────
// Hand-rolled so the binary stays zero-dep. Supports `--flag value`,
// `--flag=value`, and bare boolean `--flag`. First non-flag token is the
// command; everything else is collected by key.
function parseArgv(argv) {
	const flags = {};
	let command = null;
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === '--help' || tok === '-h') { flags.help = true; continue; }
		if (tok.startsWith('--')) {
			const body = tok.slice(2);
			const eq = body.indexOf('=');
			if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
			const next = argv[i + 1];
			if (next != null && !next.startsWith('--')) { flags[body] = next; i++; }
			else flags[body] = true;
			continue;
		}
		if (command == null) command = tok;
	}
	return { command, flags };
}

// ── small helpers ───────────────────────────────────────────────────────────

// Expected, user-facing failures throw this so main() can print a clean line
// instead of a raw Node stack trace.
class CliError extends Error {}

function fail(msg) { throw new CliError(msg); }

function readFileMaybe(p) {
	try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// A --keypair value can be a base58/json secret OR a path to a file holding one.
// Resolve to the raw secret string the wallet adapter knows how to decode.
function resolveKeypairSecret(value) {
	if (value == null || value === true) return null;
	const s = String(value).trim();
	// Looks like a filesystem path (and exists)? read it.
	if (!s.startsWith('[') && !s.startsWith('0x') && (s.includes('/') || s.includes('\\') || s.endsWith('.json'))) {
		const body = readFileMaybe(s);
		if (body == null) fail(`--keypair file not found: ${s}`);
		return body.trim();
	}
	if (fs.existsSync(s) && fs.statSync(s).isFile()) return readFileMaybe(s)?.trim() || s;
	return s;
}

// --strategy is a JSON string, a path to a .json file (one strategy or an array),
// or, when absent, the SNIPER_STRATEGIES env. Always returns an array.
function loadStrategiesFlag(value) {
	const src = value === true || value == null ? (process.env.SNIPER_STRATEGIES || '') : String(value);
	if (!src.trim()) return [];

	let text = src;
	// A path to a .json file rather than inline JSON?
	if (!src.trim().startsWith('{') && !src.trim().startsWith('[')) {
		const body = readFileMaybe(src);
		if (body == null) fail(`--strategy file not found: ${src}`);
		text = body;
	}
	let parsed;
	try { parsed = JSON.parse(text); }
	catch (err) { fail(`--strategy is not valid JSON: ${err.message}`); }
	const arr = Array.isArray(parsed) ? parsed : [parsed];
	if (!arr.length) fail('--strategy resolved to an empty list');
	return arr;
}

// SOL → lamports for the human-friendly amount fields. Strategies are stored in
// lamports; users think in SOL. Convert here so the engine sees what it expects.
function solToLamports(sol) {
	return BigInt(Math.round(Number(sol) * LAMPORTS_PER_SOL));
}

// Take an author-friendly strategy (per_trade_sol / daily_budget_sol) and emit
// the lamport-denominated shape the engine reads. Already-lamport fields pass
// through untouched. stop_loss_pct is mandatory — the engine drops strategies
// without it, so we reject early rather than silently no-op.
function normalizeStrategy(s, idx = 0) {
	if (!s || typeof s !== 'object') fail(`strategy #${idx} is not an object`);
	if (s.stop_loss_pct == null) fail(`strategy #${idx} (${s.id || 'unnamed'}) is missing stop_loss_pct — a stop-loss is mandatory`);

	const out = { ...s };
	out.id = s.id || `cli_${idx}_${Date.now().toString(36)}`;
	out.agent_id = s.agent_id || 'default';
	out.enabled = s.enabled !== false; // default armed unless explicitly disabled
	out.trigger = s.trigger || 'new_mint';

	if (out.per_trade_lamports == null) {
		if (s.per_trade_sol == null) fail(`strategy #${idx} needs per_trade_sol or per_trade_lamports`);
		out.per_trade_lamports = solToLamports(s.per_trade_sol).toString();
	} else {
		out.per_trade_lamports = String(out.per_trade_lamports);
	}
	delete out.per_trade_sol;

	if (out.daily_budget_lamports == null) {
		if (s.daily_budget_sol == null) fail(`strategy #${idx} needs daily_budget_sol or daily_budget_lamports`);
		out.daily_budget_lamports = solToLamports(s.daily_budget_sol).toString();
	} else {
		out.daily_budget_lamports = String(out.daily_budget_lamports);
	}
	delete out.daily_budget_sol;

	return out;
}

// The documented template `arm` prints when invoked without --strategy.
const STRATEGY_TEMPLATE = {
	id: 'my-first-snipe',
	agent_id: 'default',
	enabled: true,
	network: 'mainnet',
	trigger: 'new_mint',          // new_mint | intel_confirmed | first_claim | manual
	per_trade_sol: 0.05,          // SOL committed per snipe (→ per_trade_lamports)
	daily_budget_sol: 1.0,        // SOL/day ceiling (→ daily_budget_lamports)
	max_concurrent_positions: 3,
	slippage_bps: 500,            // 5.00%
	max_price_impact_pct: 10,     // entry circuit breaker
	mev_tip_mode: 'off',          // off | economy | turbo
	firewall_level: 'block',      // block | warn | off
	take_profit_pct: 80,
	stop_loss_pct: 35,            // MANDATORY — engine drops strategies without it
	trailing_stop_pct: 20,
	max_hold_seconds: 1800,
	require_socials: false,
};

// ── shared sniper construction (run / mcp / serve) ──────────────────────────
async function buildSniper(flags, { screen = false } = {}) {
	const network = flags.network || process.env.SNIPER_NETWORK || 'mainnet';
	const mode = flags.mode || process.env.SNIPER_MODE || 'simulate';
	if (mode !== 'simulate' && mode !== 'live') fail(`--mode must be simulate|live, got "${mode}"`);
	const rpcUrl = flags.rpc || process.env.SOLANA_RPC_URL || null;

	// A single default keypair drives one-agent runs; multi-agent runs resolve
	// per-agent secrets from SNIPER_WALLET_<AGENTID> env or the sqlite store.
	const keypairSecret = resolveKeypairSecret(flags.keypair);

	const rawStrategies = loadStrategiesFlag(flags.strategy);
	const strategies = rawStrategies.map((s, i) => normalizeStrategy(s, i));

	// Durable store on request; otherwise process-memory.
	let store = null;
	if (flags.sqlite || flags.db) {
		const dbPath = typeof flags.db === 'string' ? flags.db
			: typeof flags.sqlite === 'string' ? flags.sqlite
			: undefined;
		const { createSqliteStore } = await import('../src/adapters/store/sqlite.js');
		store = createSqliteStore({ path: dbPath });
		if (typeof store.addStrategy === 'function') for (const s of strategies) store.addStrategy(s);
	} else {
		store = createMemoryStore({ strategies });
	}

	const hooks = {};
	if (screen) {
		// Pretty per-event line to stderr so stdout stays clean for piping.
		hooks.onScreen = ({ text, kind }) => {
			const tag = ({ trade: 'TRADE', activity: 'LIVE', alert: 'ALERT' }[kind] || 'INFO').padEnd(5);
			process.stderr.write(`\x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${tag} ${text}\n`);
		};
	}

	// presets.local builds the wallet/solana/executor/feed wiring; we override the
	// wallet so the resolved default secret is honored without env round-trips.
	const wallet = createSelfCustodyWallet(keypairSecret ? { defaultSecret: keypairSecret } : {});

	// presets.local takes a config-ish object; re-create the wiring it does but
	// with our store + wallet so we control persistence and key resolution.
	const { createPumpClient, createWeb3Executor, createPumpPortalFeed, createSniper } = await import('../src/index.js');
	const solana = await createPumpClient({ network, rpcUrl });
	const sniper = createSniper({
		config: { network, mode, rpcUrl },
		store,
		wallet,
		solana,
		executor: createWeb3Executor(),
		feed: createPumpPortalFeed({ network }),
		hooks,
	});

	return { sniper, store, wallet, strategies, network, mode, keypairSecret };
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdRun(flags) {
	const { sniper, wallet, strategies, network, mode } = await buildSniper(flags, { screen: true });

	let walletAddr = null;
	if (strategies.length === 1 || flags.keypair) {
		const loaded = await wallet.loadKeypair(strategies[0]?.agent_id || 'default').catch(() => null);
		walletAddr = loaded?.address || null;
	}

	// ── startup banner ──
	const line = (l) => process.stderr.write(l + '\n');
	line('');
	line('  \x1b[1magent-sniper\x1b[0m — pump.fun sniper engine');
	line(`  network   ${network}`);
	line(`  mode      ${mode}${mode === 'live' ? '  \x1b[31m(LIVE — trading REAL funds)\x1b[0m' : '  (simulate — no funds at risk)'}`);
	line(`  strategies ${strategies.length}`);
	if (walletAddr) line(`  wallet    ${walletAddr}`);
	if (mode === 'live') line('  \x1b[33m⚠ live mode: every snipe spends SOL from the agent wallet. Ctrl-C to stop.\x1b[0m');
	line('');

	await sniper.start();

	let stopping = false;
	const shutdown = async (sig) => {
		if (stopping) return;
		stopping = true;
		line(`\n  ${sig} — draining and stopping…`);
		try { await sniper.stop(); } catch { /* best-effort */ }
		process.exit(0);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	// Keep the process alive; the feed + timers do the work.
	return new Promise(() => {});
}

async function cmdMcp(flags) {
	const { sniper, store } = await buildSniper(flags, { screen: false });
	let mod;
	try {
		mod = await import('../src/faces/mcp.js');
	} catch (err) {
		if (err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err?.message || '')) {
			fail('mcp face not available');
		}
		throw err;
	}
	if (typeof mod.startStdio !== 'function') fail('mcp face not available');
	await mod.startStdio({ sniper, store });
}

async function cmdServe(flags) {
	const { sniper, store } = await buildSniper(flags, { screen: false });
	const port = Number(flags.port) || 8787;
	let mod;
	try {
		mod = await import('../src/faces/api.js');
	} catch (err) {
		if (err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err?.message || '')) {
			fail('api face not available');
		}
		throw err;
	}
	const serve = mod.serve || mod.default;
	if (typeof serve !== 'function') fail('api face not available');
	await serve({ sniper, store, port });
	process.stderr.write(`agent-sniper x402 API listening on :${port}\n`);
}

async function cmdArm(flags) {
	// No --strategy: print the fill-in template.
	if (flags.strategy == null && !process.env.SNIPER_STRATEGIES) {
		process.stderr.write('// Fill in this template and pass it via --strategy (JSON string or file path).\n');
		process.stderr.write('// stop_loss_pct is mandatory; per_trade_sol / daily_budget_sol convert to lamports.\n');
		process.stdout.write(JSON.stringify(STRATEGY_TEMPLATE, null, 2) + '\n');
		return;
	}
	// --strategy given: validate + emit the normalized, lamport-converted shape.
	const raw = loadStrategiesFlag(flags.strategy);
	const normalized = raw.map((s, i) => normalizeStrategy(s, i));
	process.stdout.write(JSON.stringify(normalized.length === 1 ? normalized[0] : normalized, null, 2) + '\n');
}

async function cmdStatus(flags) {
	if (flags.url) {
		const base = String(flags.url).replace(/\/+$/, '');
		const res = await fetch(`${base}/status`).catch((err) => fail(`could not reach ${base}/status: ${err.message}`));
		if (!res.ok) fail(`status endpoint returned HTTP ${res.status}`);
		const body = await res.json().catch(() => fail('status endpoint did not return JSON'));
		process.stdout.write(JSON.stringify(body, null, 2) + '\n');
		return;
	}
	// Local: resolve config from env + flags and print it.
	const cfg = loadConfig({
		network: typeof flags.network === 'string' ? flags.network : undefined,
		mode: typeof flags.mode === 'string' ? flags.mode : undefined,
		rpcUrl: typeof flags.rpc === 'string' ? flags.rpc : undefined,
	});
	process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
}

function cmdHelp() {
	const out = `
agent-sniper — embeddable pump.fun sniper engine (@three-ws/agent-sniper)

USAGE
  agent-sniper <command> [flags]

COMMANDS
  run       Start the live/simulate trade loop and keep running.
  mcp       Run the stdio MCP server face (for AI agents / MCP clients).
  serve     Start the x402 paid HTTP API (default port 8787).
  arm       Print or validate a strategy. No network. Helper for authoring.
  status    Show local config, or probe a running server's /status (--url).
  help      Show this help.

FLAGS
  --network <mainnet|devnet>   Target cluster.            (env SNIPER_NETWORK)
  --mode <simulate|live>       Trade mode.                (env SNIPER_MODE)
  --rpc <url>                  Solana RPC endpoint.       (env SOLANA_RPC_URL)
  --keypair <base58|path|json> Default agent wallet secret (single-agent runs).
  --strategy <json|file>       Strategy JSON, or path to a .json file (one or
                               an array).                 (env SNIPER_STRATEGIES)
  --sqlite [path]              Use the durable SQLite store instead of memory.
  --db <path>                  Same as --sqlite with an explicit DB path.
  --port <n>                   HTTP port for 'serve'.     (default 8787)
  --url <url>                  Remote base URL for 'status'.

SAFETY
  Default mode is SIMULATE — no funds are ever moved. Pass '--mode live' to
  trade REAL SOL from the agent wallet. There is no confirmation prompt; live
  means live. A mandatory stop_loss_pct is enforced on every armed strategy.

WALLETS
  Single agent:  --keypair <secret>  (or SOLANA_SECRET_KEY).
  Multi-agent:   set SNIPER_WALLET_<AGENTID> env vars, or use --sqlite/--db so
                 each agent_id resolves its own self-custody key.

EXAMPLES
  # Print a strategy template to fill in
  agent-sniper arm

  # Validate a strategy file and see the lamport-normalized result
  agent-sniper arm --strategy ./my-strategy.json

  # Dry-run (simulate) against devnet with one inline strategy
  agent-sniper run --network devnet \\
    --strategy '{"id":"s1","agent_id":"a1","stop_loss_pct":35,"per_trade_sol":0.05,"daily_budget_sol":1}'

  # LIVE on mainnet with a durable store and a wallet file
  agent-sniper run --mode live --rpc https://your-rpc \\
    --keypair ./agent.json --strategy ./strategies.json --sqlite ./sniper.db

  # Run the MCP server / x402 API faces
  agent-sniper mcp   --strategy ./strategies.json
  agent-sniper serve --port 8787 --sqlite ./sniper.db

  # Inspect local config or a running server
  agent-sniper status
  agent-sniper status --url http://localhost:8787
`;
	process.stdout.write(out + '\n');
}

// ── entrypoint ──────────────────────────────────────────────────────────────
async function main() {
	const { command, flags } = parseArgv(process.argv.slice(2));

	if (!command || command === 'help' || flags.help) { cmdHelp(); return; }

	switch (command) {
		case 'run':    await cmdRun(flags); break;
		case 'mcp':    await cmdMcp(flags); break;
		case 'serve':  await cmdServe(flags); break;
		case 'arm':    await cmdArm(flags); break;
		case 'status': await cmdStatus(flags); break;
		default:
			process.stderr.write(`agent-sniper: unknown command "${command}"\n\n`);
			cmdHelp();
			process.exit(1);
	}
}

main().catch((err) => {
	// Expected (CliError) → clean one-liner. Unexpected → message only, no stack.
	process.stderr.write(`agent-sniper: ${err?.message || err}\n`);
	process.exit(1);
});
