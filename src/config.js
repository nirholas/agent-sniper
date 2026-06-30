// agent-sniper — runtime configuration.
//
// Standalone: no database or platform env is required. Reads SNIPER_* env for
// defaults, then applies an explicit overrides object (which always wins). The
// result is the immutable runtime config the engine reads on every tick.

function num(name, def) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	const n = Number(raw);
	return Number.isFinite(n) ? n : def;
}

function bool(name, def = false) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/**
 * @param {Partial<ReturnType<typeof loadConfig>>} [overrides]
 */
export function loadConfig(overrides = {}) {
	const network = (overrides.network || process.env.SNIPER_NETWORK || 'mainnet').trim();
	if (network !== 'mainnet' && network !== 'devnet') {
		throw new Error(`[agent-sniper] network must be mainnet|devnet, got "${network}"`);
	}

	const mode = (overrides.mode || process.env.SNIPER_MODE || 'simulate').trim();
	if (mode !== 'live' && mode !== 'simulate') {
		throw new Error(`[agent-sniper] mode must be live|simulate, got "${mode}"`);
	}

	// Live trading on a public RPC will 429 under the new-mint firehose. Refuse to
	// start live without a real endpoint rather than silently dropping trades.
	const rpcUrl = overrides.rpcUrl || process.env.SOLANA_RPC_URL || null;
	if (mode === 'live' && !rpcUrl && !process.env.HELIUS_API_KEY) {
		throw new Error('[agent-sniper] live mode requires rpcUrl / SOLANA_RPC_URL or HELIUS_API_KEY (public RPC will rate-limit)');
	}

	const cfg = {
		network,
		mode,
		rpcUrl,
		globalKill: overrides.globalKill ?? bool('SNIPER_GLOBAL_KILL', false),
		// Position re-quote / exit-evaluation cadence.
		pollMs: Math.max(1_000, overrides.pollMs ?? num('SNIPER_POLL_MS', 5_000)),
		// How often the strategy cache is refreshed from the Store.
		strategyRefreshMs: Math.max(5_000, overrides.strategyRefreshMs ?? num('SNIPER_STRATEGY_REFRESH_MS', 15_000)),
		// Platform-wide buy throttle — a backstop independent of per-agent caps.
		maxGlobalBuysPerMin: Math.max(0, overrides.maxGlobalBuysPerMin ?? num('SNIPER_MAX_GLOBAL_BUYS_PER_MIN', 10)),
		// Max concurrent in-flight snipe attempts (bounds RPC pressure).
		buyConcurrency: Math.max(1, overrides.buyConcurrency ?? num('SNIPER_BUY_CONCURRENCY', 3)),
		buyQueueDepth: Math.max(1, overrides.buyQueueDepth ?? num('SNIPER_BUY_QUEUE_DEPTH', 50)),
		// Confirmation timeout for a broadcast trade.
		confirmTimeoutMs: Math.max(15_000, overrides.confirmTimeoutMs ?? num('SNIPER_CONFIRM_TIMEOUT_MS', 60_000)),
		// Watchdog: if the feed delivers nothing for this long, re-subscribe.
		feedWatchdogMs: Math.max(30_000, overrides.feedWatchdogMs ?? num('SNIPER_FEED_WATCHDOG_MS', 180_000)),
		// Sentiment-flip exit (requires a Hooks/Store that supplies sentiment).
		exitOnBearish: overrides.exitOnBearish ?? bool('SNIPER_EXIT_ON_BEARISH', false),
		exitBearishMinConfidence: Math.max(0, Math.min(1, overrides.exitBearishMinConfidence ?? num('SNIPER_EXIT_BEARISH_MIN_CONFIDENCE', 0.7))),
	};
	return Object.freeze(cfg);
}
