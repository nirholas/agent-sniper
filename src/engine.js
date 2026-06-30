// agent-sniper — orchestrator.
//
// Wires a Feed → scorer → bounded buy queue, plus a position sweep on an
// interval, all over the injected adapters. createSniper() is the single public
// constructor: pass the adapters you want (or accept the defaults), call
// start(), get back a handle with stop() + introspection.

import { loadConfig } from './config.js';
import { log as defaultLog } from './log.js';
import { scoreMint, scoreIntel } from './scorer.js';
import { makeThrottle, makeQueue } from './guards.js';
import { executeBuy } from './executor.js';
import { runPositionSweep } from './positions.js';

/**
 * @param {object} deps
 * @param {Partial<ReturnType<typeof loadConfig>>} [deps.config]
 * @param {import('./types.js').Store} deps.store
 * @param {import('./types.js').Wallet} deps.wallet
 * @param {import('./types.js').SolanaClient} deps.solana
 * @param {import('./types.js').Executor} deps.executor
 * @param {import('./types.js').Feed} deps.feed
 * @param {import('./types.js').Hooks} [deps.hooks]
 * @param {Record<string, number>|null} [deps.intelWeights]
 * @param {typeof defaultLog} [deps.logger]
 */
export function createSniper(deps) {
	const cfg = loadConfig(deps.config || {});
	const log = deps.logger || defaultLog;
	const hooks = deps.hooks || {};
	const ports = { store: deps.store, wallet: deps.wallet, solana: deps.solana, executor: deps.executor, hooks, log };
	if (!ports.store || !ports.wallet || !ports.solana || !ports.executor || !deps.feed) {
		throw new Error('[agent-sniper] createSniper requires store, wallet, solana, executor, and feed adapters');
	}

	const throttle = makeThrottle(cfg.maxGlobalBuysPerMin);
	let strategies = [];
	let stopFeed = null;
	let sweepTimer = null;
	let refreshTimer = null;
	let draining = false;
	let lastEventAt = Date.now();
	const stats = { events: 0, candidates: 0, buys: 0, sells: 0, errors: 0 };

	const queue = makeQueue(cfg.buyConcurrency, cfg.buyQueueDepth, {
		onError: (err) => { stats.errors++; log.error('buy job crashed', { err: err?.message }); },
		onDrop: () => log.warn('buy queue full — dropping snipe'),
	});

	async function refreshStrategies() {
		try {
			strategies = await ports.store.getArmedStrategies(cfg.network);
		} catch (err) {
			log.error('strategy refresh failed', { err: err?.message });
		}
	}

	function screen(text, kind) { try { hooks.onScreen?.({ text, kind }); } catch { /* best-effort */ } }

	function onEvent({ kind, data }) {
		lastEventAt = Date.now();
		stats.events++;
		if (draining || cfg.globalKill || !data?.mint) return;
		const sym = (data.symbol || data.mint.slice(0, 6)).toUpperCase();

		for (const strat of strategies) {
			const trig = strat.trigger || 'new_mint';
			// Route the event to strategies whose trigger matches its kind.
			if (kind === 'mint' && trig !== 'new_mint') continue;
			if (kind === 'intel' && trig !== 'intel_confirmed') continue;
			if (kind === 'claim' && trig !== 'first_claim') continue;
			if (!['mint', 'intel', 'claim'].includes(kind)) continue;

			const { pass, score, reasons } = trig === 'intel_confirmed'
				? scoreIntel(data, strat, deps.intelWeights || null)
				: scoreMint(data, strat);
			if (!pass) continue;

			stats.candidates++;
			log.info('candidate', { agent: strat.agent_id, mint: data.mint, symbol: data.symbol, score, reasons });
			screen(`$${sym} scored ${score} — BUYING`, 'trade');
			queue.push(async () => {
				const res = await executeBuy({ cfg, strat, candidate: data, throttle, ports });
				if (res?.status === 'open') stats.buys++;
			});
		}
	}

	async function sweep() {
		await runPositionSweep(cfg, ports);
	}

	return {
		config: cfg,
		stats: () => ({ ...stats, strategies: strategies.length, queued: queue.inFlight, lastEventAt }),
		strategies: () => strategies.slice(),

		async start() {
			log.info('boot', { network: cfg.network, mode: cfg.mode, globalKill: cfg.globalKill, pollMs: cfg.pollMs });
			screen(`Sniper online — ${cfg.network} / ${cfg.mode} mode`, 'activity');
			await refreshStrategies();
			refreshTimer = setInterval(refreshStrategies, cfg.strategyRefreshMs);
			refreshTimer.unref?.();
			sweepTimer = setInterval(() => { sweep().catch((err) => log.error('sweep failed', { err: err?.message })); }, cfg.pollMs);
			sweepTimer.unref?.();
			stopFeed = await deps.feed.start(onEvent);
			return this;
		},

		/** Score + (queue) a single candidate by hand — drives the `manual` trigger / MCP snipe_now. */
		submitCandidate(candidate, { force = false } = {}) {
			if (force) {
				// Bypass the feed scorer: run every armed strategy's buy directly.
				for (const strat of strategies) {
					queue.push(() => executeBuy({ cfg, strat, candidate, throttle, ports }));
				}
				return;
			}
			onEvent({ kind: candidate.entry_trigger === 'intel_confirmed' ? 'intel' : 'mint', data: candidate });
		},

		async stop() {
			draining = true;
			try { stopFeed?.(); } catch { /* feed already closed */ }
			if (sweepTimer) clearInterval(sweepTimer);
			if (refreshTimer) clearInterval(refreshTimer);
			log.info('shutdown', stats);
		},
	};
}
