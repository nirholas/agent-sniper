// agent-sniper — 3D agent layer.
//
// The "embodiment" half of @three-ws/agent-sniper. The engine (engine.js) runs
// the trade loop; this module turns a Strategy + an avatar choice into a
// renderable 3D-agent config, and normalizes the live screen-push events the
// engine already emits (Hooks.onScreen) into desk-monitor frames a web watch
// view or the in-world desk can paint.
//
// Product vision: every user's sniper is embodied by a humanoid AI agent
// standing at a desk in /play, whose monitor shows live sniping activity. The
// avatars + animation clips referenced here are REAL three.ws assets shipped
// under public/ (so the same URLs resolve in /play, /agent-screen, and the SDK):
//
//   • Avatars   — public/avatars/*.glb (default.glb, mannequin.glb, …).
//   • Animation — public/animations/manifest.json canonical clips ('idle',
//     'walk'). Any humanoid rig can be driven by them: src/glb-canonicalize.js
//     maps its bone names to the canonical set and src/animation-retarget.js
//     retargets the clip on, so we never need a per-avatar clip — the three.ws
//     avatar stack handles retargeting at render time.
//
// Pure ESM, zero runtime deps, zero three.ws backend imports. This is a data /
// config module: it references asset paths as plain strings and shapes events;
// it never loads GLBs, opens an SSE connection, or reads the clock. Frame ids
// are deterministic — pass a `ts` in if you want one, otherwise it stays null.

/** lamports → SOL, matching executor.js's `lamportsToSol`. @param {string|number|bigint} l */
const lamportsToSol = (l) => (l == null ? 0 : Number(BigInt(l)) / 1e9);

/**
 * Selectable 3D-agent avatar presets. Every `glb` is a REAL asset shipped at
 * that absolute path under three.ws/public — e.g. `/avatars/default.glb`
 * resolves to https://three.ws/avatars/default.glb in production and is served
 * locally by Vite in dev. The first entry is the platform default.
 *
 * @type {ReadonlyArray<{ id: string, name: string, glb: string, description: string }>}
 */
export const AGENT_AVATARS = Object.freeze([
	{
		id: 'default',
		name: 'Operator',
		glb: '/avatars/default.glb',
		description: 'The three.ws default rig — neutral humanoid, fits any desk.',
	},
	{
		id: 'mannequin',
		name: 'Mannequin',
		glb: '/avatars/mannequin.glb',
		description: 'Clean studio mannequin. Reads well on the monitor backlight.',
	},
	{
		id: 'michelle',
		name: 'Michelle',
		glb: '/avatars/michelle.glb',
		description: 'Stylized analyst — expressive face for narration moments.',
	},
	{
		id: 'realistic-male',
		name: 'Trader',
		glb: '/avatars/realistic-male.glb',
		description: 'Realistic humanoid trader, head-down at the terminal.',
	},
]);

/** The platform default avatar (first preset). @type {AGENT_AVATARS[number]} */
const DEFAULT_AVATAR = AGENT_AVATARS[0];

/**
 * Canonical animation clips ANY humanoid avatar can be driven by. These names
 * are the REAL entries in public/animations/manifest.json. Retargeting onto an
 * arbitrary rig is handled by the three.ws avatar stack (glb-canonicalize.js →
 * animation-retarget.js) at render time — no per-avatar clip is needed here.
 *
 *   idle — the desk figure's resting/breathing loop while it waits for signal.
 *   walk — locomotion clip, used if the agent paces between events.
 *
 * @type {{ idle: string, walk: string }}
 */
export const ANIMATION_CLIPS = Object.freeze({
	idle: 'idle',
	walk: 'walk',
});

/**
 * Resolve a preset by id, falling back to the platform default when the id is
 * missing or unknown. Never returns null — the desk always has a body to spawn.
 * @param {string} [avatarId]
 * @returns {AGENT_AVATARS[number]}
 */
function resolveAvatar(avatarId) {
	if (!avatarId) return DEFAULT_AVATAR;
	return AGENT_AVATARS.find((a) => a.id === avatarId) || DEFAULT_AVATAR;
}

/**
 * Bind a sniper Strategy to an avatar and produce a renderable 3D-agent config.
 * Lamport fields are converted to SOL for display; the raw strategy is never
 * mutated. The returned shape is what a desk spawner / web watch view consumes.
 *
 * @param {object} p
 * @param {import('../types.js').Strategy} p.strategy   the armed strategy to embody
 * @param {string} [p.avatarId]   one of AGENT_AVATARS[].id (falls back to default)
 * @param {string} [p.name]       display name override (else strategy.agent_name)
 * @returns {{
 *   agentId: string,
 *   name: string,
 *   avatar: AGENT_AVATARS[number],
 *   animations: { idle: string, walk: string },
 *   desk: { screen: boolean },
 *   strategySummary: {
 *     trigger: string,
 *     perTradeSol: number,
 *     dailyBudgetSol: number,
 *     stopLossPct: number|null,
 *     takeProfitPct: number|null,
 *   },
 * }}
 */
export function agentConfig({ strategy, avatarId, name } = {}) {
	if (!strategy || !strategy.agent_id) {
		throw new Error('[agent-sniper/manifest] agentConfig requires a strategy with an agent_id');
	}
	const avatar = resolveAvatar(avatarId);
	return {
		agentId: strategy.agent_id,
		name: name || strategy.agent_name || 'Sniper',
		avatar,
		animations: ANIMATION_CLIPS,
		desk: { screen: true },
		strategySummary: {
			trigger: strategy.trigger || 'new_mint',
			perTradeSol: lamportsToSol(strategy.per_trade_lamports),
			dailyBudgetSol: lamportsToSol(strategy.daily_budget_lamports),
			stopLossPct: strategy.stop_loss_pct ?? null,
			takeProfitPct: strategy.take_profit_pct ?? null,
		},
	};
}

// Phase classification + accent palette. `kind`/`type`/`phase` on a screen-push
// event is one of the engine's three categories (engine.js screen() helper and
// agent-screen-sniper-wiring.md): 'analysis', 'trade', 'activity'. A 'trade'
// frame is colored by P&L direction when a delta is present, so a win reads
// green and a loss reads red on the monitor; 'analysis' is the scoring blue and
// 'activity' is the neutral status gray.
const ACCENTS = Object.freeze({
	analysis: '#5b8fff', // blue — matches walk-agent-desk.js PAL.accent
	tradeUp: '#3ddc84',  // green — matches walk-agent-desk.js PAL.live
	tradeDown: '#ff5b6e',// red
	tradeFlat: '#3ddc84',// green — a trade with no signed delta still reads "live"
	activity: '#8a90a2', // gray — neutral status line
});

/** Map a raw screen-push kind to a normalized phase. */
function normalizePhase(kind) {
	const k = String(kind || 'activity').toLowerCase();
	if (k === 'analysis' || k === 'scored' || k === 'score' || k === 'hold') return 'analysis';
	if (k === 'trade' || k === 'buy' || k === 'sell' || k === 'exit') return 'trade';
	return 'activity';
}

/** Pick the first finite signed number from a list of candidates, else null. */
function firstNumber(...vals) {
	for (const v of vals) {
		if (v == null || v === '') continue;
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

/**
 * Normalize a single screen-push event into a desk-monitor frame the 3D desk
 * (walk-agent-desk.js) or the 2D web watch view can render. Pure and
 * deterministic: no Date.now, no Math.random. Pass `ts` to stamp the frame;
 * omit it and `ts` stays null (the renderer assigns its own arrival time).
 *
 * Accepts the SAME event shape the engine emits and agent-screen-sniper-wiring
 * documents: { text, kind|type|phase, mint?, symbol?, solDelta?, pct? }.
 *
 * @param {{
 *   text?: string,
 *   activity?: string,
 *   kind?: string, type?: string, phase?: string,
 *   mint?: string,
 *   symbol?: string,
 *   solDelta?: number|string,
 *   pct?: number|string,
 * }} [event]
 * @param {number|null} [ts]   optional frame timestamp (ms). Default null.
 * @returns {{
 *   ts: number|null,
 *   phase: 'analysis'|'trade'|'activity',
 *   line: string,
 *   accent: string,
 *   ticker?: { symbol: string|null, solDelta: number|null, pct: number|null },
 * }}
 */
export function deskMonitorFrame(event = {}, ts = null) {
	const phase = normalizePhase(event.kind ?? event.type ?? event.phase);
	const line = String(event.text ?? event.activity ?? '').trim();
	const symbol = event.symbol ? String(event.symbol).toUpperCase() : null;
	const solDelta = firstNumber(event.solDelta);
	const pct = firstNumber(event.pct);

	let accent;
	if (phase === 'analysis') {
		accent = ACCENTS.analysis;
	} else if (phase === 'trade') {
		const dir = solDelta != null ? solDelta : pct;
		accent = dir == null ? ACCENTS.tradeFlat : dir < 0 ? ACCENTS.tradeDown : ACCENTS.tradeUp;
	} else {
		accent = ACCENTS.activity;
	}

	/** @type {{ ts: number|null, phase: string, line: string, accent: string, ticker?: object }} */
	const frame = {
		ts: ts ?? null,
		phase,
		line,
		accent,
	};

	// Attach a P&L ticker only when there's something quantitative to show.
	if (symbol || solDelta != null || pct != null) {
		frame.ticker = { symbol, solDelta, pct };
	}

	return frame;
}
