// @three-ws/agent-sniper — MCP (Model Context Protocol) stdio face.
//
// Exposes the sniper engine as an MCP stdio server so AI agents / Claude can arm
// strategies, snipe pump.fun coins by hand, and inspect open positions — all over
// the same engine handle the CLI and HTTP faces drive. Every tool maps 1:1 onto a
// public engine/store method; no engine internals are reached around.
//
// Run standalone:
//   node src/faces/mcp.js
//   # network/mode come from SNIPER_NETWORK / SNIPER_MODE when no sniper is injected.
//
// Or wire into Claude Desktop / Cursor by pointing the MCP client at that command.
//
// Testability: `createSniperMcpServer(deps)` builds and returns the fully-registered
// McpServer WITHOUT connecting any transport — safe to construct in a test and call
// server.connect(new InMemoryTransport()) on. The stdio boot in `startStdio()` runs
// only when this file is the process entry point.
//
// x402 note: this base server is intentionally unauthenticated and local. Paid
// gating can be layered by wrapping each tool handler (settle USDC, then delegate) —
// the three.ws *hosted* MCP does exactly that. We do NOT implement payment here; the
// surface stays lightweight so anyone can run it against their own wallet/RPC.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Advertised MCP version tracks package.json so it can't drift from the npm release.
const { version: PKG_VERSION } = createRequire(import.meta.url)('../../package.json');

const SERVER_INSTRUCTIONS =
	'agent-sniper over MCP: arm per-agent pump.fun snipe strategies, fire manual buys, and inspect ' +
	'positions, all driving a real sniper engine. arm_strategy registers a policy (stop_loss_pct is ' +
	'mandatory; SOL amounts are converted to lamports for you). snipe_now forces a manual buy across ' +
	'armed agents. list_strategies / list_positions / sniper_status are read-only. close_position and ' +
	'disarm_strategy change behavior. This server is unauthenticated and meant to run locally against ' +
	'your own wallet/RPC — never expose it on an open port without a payment/auth wrapper.';

// One SOL = 1e9 lamports. SOL inputs are floats; lamports are integers stored as a
// decimal string so a BigInt round-trips through JSON without precision loss.
const LAMPORTS_PER_SOL = 1_000_000_000n;
const solToLamportsString = (sol) => {
	// Scale via integer math on a fixed-precision string to avoid float drift on the
	// fractional part (e.g. 0.1 SOL must land on exactly 100000000 lamports).
	const [whole, frac = ''] = String(sol).split('.');
	const fracPadded = (frac + '000000000').slice(0, 9);
	const lamports = BigInt(whole || '0') * LAMPORTS_PER_SOL + BigInt(fracPadded || '0');
	return lamports.toString();
};

let _idSeq = 0;
const nextStrategyId = () => `strat_${Date.now().toString(36)}_${(++_idSeq).toString(36)}`;

// MCP result envelope helpers. Every handler returns JSON in both a text content
// block (for clients that only read content) and structuredContent (for clients on
// the typed-result path). Errors flip isError but still carry a readable payload.
const ok = (result) => ({
	content: [{ type: 'text', text: JSON.stringify(result) }],
	structuredContent: result,
});
const fail = (err) => {
	const message = err?.message || String(err);
	const payload = { ok: false, error: message };
	return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
};

// Write a strategy through whichever method the store exposes. A generic store may
// offer upsertStrategy; the default memory store offers addStrategy (which also
// upserts by id). Either way the stored row is returned to the caller.
function writeStrategy(store, strategy) {
	if (typeof store.upsertStrategy === 'function') return store.upsertStrategy(strategy);
	if (typeof store.addStrategy === 'function') return store.addStrategy(strategy);
	throw new Error('store exposes neither upsertStrategy nor addStrategy — cannot arm a strategy');
}

// Read a single strategy by id from the engine's live strategy cache.
const findStrategy = (sniper, id) => sniper.strategies().find((s) => s.id === id) || null;

/**
 * Build a fully-registered agent-sniper McpServer WITHOUT connecting a transport.
 *
 * @param {object} [deps]
 * @param {object} [deps.sniper]  an already-built sniper handle (createSniper / presets.*).
 *   When omitted, a default `presets.local` sniper is built from SNIPER_NETWORK /
 *   SNIPER_MODE env, and started so tools operate against a live engine.
 * @param {import('../types.js').Store} [deps.store]  the store backing `deps.sniper`
 *   (so tools can read/write strategies + positions). Required when `deps.sniper` is
 *   supplied; auto-derived when this function builds the default sniper.
 * @returns {Promise<McpServer>}
 */
export async function createSniperMcpServer(deps = {}) {
	let { sniper, store } = deps;

	if (!sniper) {
		// No injected handle → stand up the zero-config local wiring. Build the store
		// first so it's shared with the sniper and reachable by the tools.
		const { createMemoryStore } = await import('../adapters/store/memory.js');
		store = store || createMemoryStore({});
		const { createPumpClient } = await import('../adapters/solana/pump-client.js');
		const { createSelfCustodyWallet } = await import('../adapters/wallet/self-custody.js');
		const { createWeb3Executor } = await import('../adapters/solana/executor-web3.js');
		const { createPumpPortalFeed } = await import('../adapters/feed/pumpportal.js');
		const { createSniper } = await import('../engine.js');
		const network = (process.env.SNIPER_NETWORK || 'mainnet').trim();
		const mode = (process.env.SNIPER_MODE || 'simulate').trim();
		const solana = await createPumpClient({ network });
		sniper = createSniper({
			config: { network, mode },
			store,
			wallet: createSelfCustodyWallet({}),
			solana,
			executor: createWeb3Executor(),
			feed: createPumpPortalFeed({ network }),
		});
		await sniper.start();
	}

	if (!store) {
		throw new Error('[agent-sniper/mcp] deps.store is required when deps.sniper is supplied');
	}

	const server = new McpServer(
		{ name: 'agent-sniper', version: PKG_VERSION },
		{
			// Our tool surface is fixed per-process — declare tools with no
			// list_changed notifications so strict 2025-06-18 clients don't wait for them.
			capabilities: { tools: { listChanged: false } },
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	// ── arm_strategy ──────────────────────────────────────────────────────────────
	// Registers / updates an armed strategy. Not read-only (it changes future trading
	// behavior) but not destructive (it creates state, deletes nothing). SOL ceilings
	// are converted to lamport strings to match the Strategy contract.
	server.registerTool(
		'arm_strategy',
		{
			title: 'Arm snipe strategy',
			description:
				'Register (or update) a pump.fun snipe strategy for an agent. SOL amounts are converted to ' +
				'lamports for you. stop_loss_pct is mandatory — the engine refuses to arm without it. Returns ' +
				'the stored strategy row.',
			inputSchema: {
				agentId: z.string().min(1).describe('Owning agent id — one wallet per agent.'),
				strategyId: z.string().min(1).optional().describe('Reuse to update an existing strategy; omit to create one.'),
				per_trade_sol: z.number().positive().describe('SOL committed per snipe.'),
				daily_budget_sol: z.number().positive().describe('SOL/day spend ceiling for this agent.'),
				stop_loss_pct: z.number().describe('REQUIRED. Exit when down this percent from entry.'),
				take_profit_pct: z.number().optional().describe('Exit when up this percent from entry.'),
				trailing_stop_pct: z.number().optional().describe('Exit when down this percent from peak.'),
				max_hold_seconds: z.number().int().positive().optional().describe('Hard time-stop (default 1800).'),
				slippage_bps: z.number().int().nonnegative().optional().describe('Entry slippage tolerance, bps (default 500).'),
				max_price_impact_pct: z.number().optional().describe('Entry circuit breaker (default 10).'),
				trigger: z.enum(['new_mint', 'intel_confirmed', 'first_claim', 'manual']).optional().describe('What fires the buy.'),
				network: z.enum(['mainnet', 'devnet']).optional().describe('Chain (defaults to the sniper network).'),
				mev_tip_mode: z.enum(['off', 'economy', 'turbo']).optional().describe('MEV tip aggressiveness.'),
				firewall_level: z.enum(['block', 'warn', 'off']).optional().describe('Rug/honeypot firewall posture.'),
				min_market_cap_usd: z.number().optional().describe('Skip candidates below this market cap.'),
				max_market_cap_usd: z.number().optional().describe('Skip candidates above this market cap.'),
				require_socials: z.boolean().optional().describe('Require twitter/telegram/website on the candidate.'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (input) => {
			try {
				const id = input.strategyId || nextStrategyId();
				const strategy = {
					id,
					agent_id: input.agentId,
					enabled: true,
					trigger: input.trigger || 'new_mint',
					network: input.network || sniper.config.network,
					per_trade_lamports: solToLamportsString(input.per_trade_sol),
					daily_budget_lamports: solToLamportsString(input.daily_budget_sol),
					stop_loss_pct: input.stop_loss_pct,
				};
				// Only set optional fields when supplied — keep the row clean for stores
				// that round-trip it to a typed column (null vs absent matters in SQL).
				if (input.take_profit_pct != null) strategy.take_profit_pct = input.take_profit_pct;
				if (input.trailing_stop_pct != null) strategy.trailing_stop_pct = input.trailing_stop_pct;
				if (input.max_hold_seconds != null) strategy.max_hold_seconds = input.max_hold_seconds;
				if (input.slippage_bps != null) strategy.slippage_bps = input.slippage_bps;
				if (input.max_price_impact_pct != null) strategy.max_price_impact_pct = input.max_price_impact_pct;
				if (input.mev_tip_mode != null) strategy.mev_tip_mode = input.mev_tip_mode;
				if (input.firewall_level != null) strategy.firewall_level = input.firewall_level;
				if (input.min_market_cap_usd != null) strategy.min_market_cap_usd = input.min_market_cap_usd;
				if (input.max_market_cap_usd != null) strategy.max_market_cap_usd = input.max_market_cap_usd;
				if (input.require_socials != null) strategy.require_socials = input.require_socials;

				const stored = (await writeStrategy(store, strategy)) || strategy;
				return ok({ ok: true, strategy: stored });
			} catch (err) {
				return fail(err);
			}
		},
	);

	// ── disarm_strategy ─────────────────────────────────────────────────────────────
	// Flips a strategy off. Patches enabled=false (re-arm later by id) rather than
	// deleting, so the policy isn't lost. Falls back to removeStrategy if the store
	// can't patch. Marked destructive: it stops future buys for the agent.
	server.registerTool(
		'disarm_strategy',
		{
			title: 'Disarm snipe strategy',
			description: 'Disable an armed strategy (enabled=false). The agent stops sniping new candidates; open positions still exit on their own rules.',
			inputSchema: { strategyId: z.string().min(1).describe('Strategy id to disarm.') },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async ({ strategyId }) => {
			try {
				const cur = findStrategy(sniper, strategyId);
				if (cur) {
					await writeStrategy(store, { ...cur, enabled: false });
				} else if (typeof store.removeStrategy === 'function') {
					store.removeStrategy(strategyId);
				} else {
					return fail(new Error(`strategy "${strategyId}" not found`));
				}
				return ok({ ok: true, strategyId, enabled: false });
			} catch (err) {
				return fail(err);
			}
		},
	);

	// ── list_strategies ─────────────────────────────────────────────────────────────
	server.registerTool(
		'list_strategies',
		{
			title: 'List armed strategies',
			description: 'List every currently armed strategy the sniper is evaluating candidates against.',
			inputSchema: {},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async () => {
			try {
				const strategies = sniper.strategies();
				return ok({ ok: true, count: strategies.length, strategies });
			} catch (err) {
				return fail(err);
			}
		},
	);

	// ── snipe_now ───────────────────────────────────────────────────────────────────
	// Force a manual buy of a specific mint. force:true bypasses the feed scorer and
	// runs every armed strategy's buy directly. Not read-only — it spends.
	server.registerTool(
		'snipe_now',
		{
			title: 'Snipe a mint now',
			description: 'Force a manual buy of a pump.fun mint across all armed agents (bypasses the candidate scorer). In simulate mode no funds move.',
			inputSchema: {
				mint: z.string().min(1).describe('The pump.fun token mint to buy.'),
				symbol: z.string().optional().describe('Optional ticker for logs/screen.'),
				agentId: z.string().optional().describe('Reserved for future per-agent targeting; current build snipes all armed agents.'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async ({ mint, symbol, agentId }) => {
			try {
				const candidate = { mint, entry_trigger: 'manual' };
				if (symbol) candidate.symbol = symbol;
				sniper.submitCandidate(candidate, { force: true });
				return ok({ ok: true, scheduled: true, mint, agentId: agentId || null });
			} catch (err) {
				return fail(err);
			}
		},
	);

	// ── list_positions ──────────────────────────────────────────────────────────────
	server.registerTool(
		'list_positions',
		{
			title: 'List positions',
			description: 'List sniper positions, optionally filtered by agentId and/or status (opening|open|closing|closed|failed).',
			inputSchema: {
				agentId: z.string().optional().describe('Filter to one agent.'),
				status: z.enum(['opening', 'open', 'closing', 'closed', 'failed']).optional().describe('Filter by lifecycle status.'),
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ agentId, status }) => {
			try {
				if (typeof store.listPositions !== 'function') {
					throw new Error('store does not expose listPositions — cannot enumerate positions');
				}
				const positions = await store.listPositions({ agentId, network: sniper.config.network, status });
				return ok({ ok: true, count: positions.length, positions });
			} catch (err) {
				return fail(err);
			}
		},
	);

	// ── close_position ──────────────────────────────────────────────────────────────
	// The engine handle deliberately does not expose executeSell, so rather than
	// reaching into the executor we flip the position's kill_switch via the store. The
	// next position sweep (cfg.pollMs) sees kill_switch and exits the position through
	// the normal sell path — same code, no duplicated broadcast logic. Hence the result
	// is { scheduled: true }: the close is queued for the upcoming sweep, not synchronous.
	server.registerTool(
		'close_position',
		{
			title: 'Close a position',
			description: 'Schedule an exit for an open position. Flips its kill switch; the next position sweep sells it through the normal exit path. Returns once scheduled — the sell lands shortly after.',
			inputSchema: { positionId: z.string().min(1).describe('Position id to close (from list_positions).') },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async ({ positionId }) => {
			try {
				if (typeof store.listPositions !== 'function' || typeof store.updatePosition !== 'function') {
					throw new Error('store must expose listPositions + updatePosition to close a position');
				}
				const all = await store.listPositions({ network: sniper.config.network });
				const pos = all.find((p) => p.id === positionId);
				if (!pos) return fail(new Error(`position "${positionId}" not found on ${sniper.config.network}`));
				if (pos.status === 'closed' || pos.status === 'failed') {
					return ok({ ok: true, scheduled: false, positionId, status: pos.status, note: 'position already terminal' });
				}
				await store.updatePosition(positionId, { kill_switch: true });
				return ok({ ok: true, scheduled: true, positionId });
			} catch (err) {
				return fail(err);
			}
		},
	);

	// ── sniper_status ───────────────────────────────────────────────────────────────
	server.registerTool(
		'sniper_status',
		{
			title: 'Sniper status',
			description: 'Engine health snapshot: event/candidate/buy/sell counts, armed-strategy count, queue depth, plus the network and mode.',
			inputSchema: {},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async () => {
			try {
				const result = {
					ok: true,
					network: sniper.config.network,
					mode: sniper.config.mode,
					stats: sniper.stats(),
				};
				return ok(result);
			} catch (err) {
				return fail(err);
			}
		},
	);

	return server;
}

/**
 * Build the server and connect it over stdio. stdout is reserved for MCP JSON-RPC
 * frames, so all human logging goes to stderr.
 *
 * @param {object} [deps]  same shape as createSniperMcpServer.
 * @returns {Promise<McpServer>}
 */
export async function startStdio(deps = {}) {
	const server = await createSniperMcpServer(deps);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[agent-sniper/mcp] ready — sniper tools registered over stdio (v${PKG_VERSION})`);
	return server;
}

// Run the stdio boot ONLY when this file is the process entry point. Importing the
// module (tests, the CLI `mcp` subcommand reusing createSniperMcpServer) must NOT
// connect a transport. argv[1] is compared both directly and via realpath so a launch
// through an npm-bin symlink still resolves to this module.
function isProcessEntryPoint() {
	const argvPath = process.argv[1];
	if (!argvPath) return false;
	if (import.meta.url === pathToFileURL(argvPath).href) return true;
	try {
		return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
	} catch {
		return false;
	}
}

if (isProcessEntryPoint()) {
	startStdio().catch((err) => {
		console.error(`agent-sniper/mcp: ${err?.message || err}`);
		process.exit(1);
	});
}

export default { createSniperMcpServer, startStdio };
