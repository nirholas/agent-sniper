// agent-sniper — the only module that signs and broadcasts.
//
// executeBuy / executeSell own every guardrail, the idempotency claim, the trade
// build, the broadcast, and the position writes — all through the injected
// adapters (Store, Wallet, Solana, Executor) and optional Hooks. In `simulate`
// mode the full path runs against REAL on-chain quotes but the broadcast is
// skipped (sig = 'SIMULATED'). No three.ws / Postgres coupling.

import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
	checkConcurrency, checkDailyBudgetLamports, checkSolHeadroom, checkPriceImpact,
	snipeConfidence, SOL_FEE_HEADROOM_LAMPORTS,
} from './guards.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ── per-agent serialization ──────────────────────────────────────────────────
// A per-agent in-process lock makes the budget + concurrency checks race-free
// within one process. (Horizontal scaling needs an atomic Store reservation — see
// README "Scaling beyond one process".)
const _locks = new Map();
async function withAgentLock(agentId, fn) {
	const prev = _locks.get(agentId) || Promise.resolve();
	let release;
	const next = new Promise((r) => (release = r));
	_locks.set(agentId, prev.then(() => next));
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (_locks.get(agentId) === next) _locks.delete(agentId);
	}
}

const toBN = (v) => new BN(BigInt(v).toString());
const lamportsToSol = (l) => Number(BigInt(l)) / 1e9;
const symOf = (m) => (m.symbol || m.mint.slice(0, 6)).toUpperCase();

/**
 * @typedef {object} Ports
 * @property {import('./types.js').Store} store
 * @property {import('./types.js').Wallet} wallet
 * @property {import('./types.js').SolanaClient} solana
 * @property {import('./types.js').Executor} executor
 * @property {import('./types.js').Hooks} hooks
 * @property {typeof import('./log.js').log} log
 */

/**
 * Attempt to snipe `candidate` for `strat`. All checks short-circuit before any
 * tx is built. Returns a small status object; never throws.
 *
 * @param {object} p
 * @param {ReturnType<import('./config.js').loadConfig>} p.cfg
 * @param {import('./types.js').Strategy} p.strat
 * @param {import('./types.js').Candidate} p.candidate
 * @param {{ tryConsume: () => boolean }} p.throttle
 * @param {Ports} p.ports
 */
export async function executeBuy({ cfg, strat, candidate, throttle, ports }) {
	const { store, wallet, solana, executor, hooks, log } = ports;
	return withAgentLock(strat.agent_id, async () => {
		const perTrade = BigInt(strat.per_trade_lamports);
		const tag = { agent: strat.agent_id, mint: candidate.mint, symbol: candidate.symbol };
		const screen = (text, kind, extra) => safe(() => hooks.onScreen?.({ text, kind, ...extra }));

		// 1. global throttle (platform-wide backstop)
		if (!throttle.tryConsume()) return skip(log, tag, 'global_throttle');

		// 2. concurrency cap
		const open = await store.countOpenPositions(strat.agent_id, cfg.network);
		const conc = checkConcurrency(open, strat.max_concurrent_positions);
		if (conc) return skip(log, tag, conc.reason);

		// 3. daily budget cap
		const spent = await store.getDailySpendLamports(strat.agent_id, cfg.network);
		const budget = checkDailyBudgetLamports(spent, perTrade, BigInt(strat.daily_budget_lamports));
		if (budget) return skip(log, tag, budget.reason);

		// 4. optional oracle/conviction gate
		if (hooks.oracleGate) {
			const og = await safeAsync(() => hooks.oracleGate({ agentId: strat.agent_id, candidate, network: cfg.network, strategy: strat }));
			if (og && og.pass === false) {
				screen(`$${symOf(candidate)} oracle blocked: ${og.reason}`, 'analysis');
				return skip(log, tag, og.reason || 'oracle_gate');
			}
		}

		// 5. idempotency claim — reserve (agent,mint,network) BEFORE the tx.
		const position = await store.claimPosition({ strategy: strat, candidate, network: cfg.network });
		if (!position) return skip(log, tag, 'already_held');
		const posId = position.id;

		try {
			// 6. agent wallet + funds
			const loaded = await wallet.loadKeypair(strat.agent_id, { userId: strat.user_id, reason: 'sniper_buy' });
			if (!loaded) return await fail(store, log, posId, tag, 'no_wallet');
			const { keypair, address } = loaded;
			await store.updatePosition(posId, { wallet: address });

			const balance = BigInt(await solana.connection.getBalance(keypair.publicKey, 'confirmed'));
			const headroom = checkSolHeadroom(balance, perTrade, SOL_FEE_HEADROOM_LAMPORTS);
			if (headroom) return await fail(store, log, posId, tag, headroom.reason);

			const mintPk = new PublicKey(candidate.mint);
			const slippagePct = (strat.slippage_bps ?? 500) / 100;

			// 7. quote + price-impact circuit breaker
			const quote = await solana.quoteForBuy({ mint: mintPk, quoteLamports: perTrade, slippagePct });
			if (strat.require_sol_quote !== false && quote.quoteMint && quote.quoteMint.toBase58 &&
				quote.quoteMint.toBase58() !== WSOL_MINT && !quote.quoteMint.equals?.(PublicKey.default)) {
				return await fail(store, log, posId, tag, 'quote_not_sol');
			}
			const impact = checkPriceImpact(Number(quote.priceImpactPct), Number(strat.max_price_impact_pct));
			if (impact) return await fail(store, log, posId, tag, impact.reason);

			// 8. rug/honeypot firewall (optional hook). 'block' aborts a block verdict;
			// 'warn' logs + proceeds; 'off' skips. A hook throw degrades to 'warn'.
			const firewallLevel = ['warn', 'off'].includes(strat.firewall_level) ? strat.firewall_level : 'block';
			let firewall = null;
			if (firewallLevel !== 'off' && hooks.assessSafety) {
				const a = await safeAsync(() => hooks.assessSafety({
					network: cfg.network, mint: candidate.mint, side: 'buy',
					payer: keypair.publicKey, quoteLamports: perTrade,
					connection: solana.connection, priceImpactPct: Number(quote.priceImpactPct),
				}));
				if (a) {
					if (firewallLevel === 'block' && a.verdict === 'block') {
						const reason = a.reasons?.[0] || 'firewall_blocked';
						await store.updatePosition(posId, { status: 'failed', error: `firewall_block: ${reason}`.slice(0, 280) });
						log.warn('buy blocked by firewall', { ...tag, score: a.score, reasons: a.reasons });
						screen(`$${symOf(candidate)} blocked by firewall: ${reason}`, 'analysis');
						return { status: 'failed', reason: 'firewall_block' };
					}
					firewall = { verdict: a.verdict, score: a.score };
				}
			}

			// 9. build + (live) broadcast
			const built = await solana.buildBuyInstructions({ mint: mintPk, user: keypair.publicKey, quoteLamports: perTrade, slippagePct });
			const baseAmount = BigInt(built.expectedBaseTokens.toString());
			if (baseAmount <= 0n) return await fail(store, log, posId, tag, 'zero_tokens');

			let sig = 'SIMULATED';
			let exec = { route: 'simulated', tipLamports: 0n, priorityFeeMicroLamports: null, landedMs: null, attempts: 0 };
			screen(`Buying $${symOf(candidate)} — sending tx`, 'trade');
			if (cfg.mode === 'live') {
				const tipMode = ['economy', 'turbo'].includes(strat.mev_tip_mode) ? strat.mev_tip_mode : 'off';
				const onTip = makeTipGuard({ strat, spentLamports: spent, committedLamports: perTrade, store, mint: candidate.mint });
				const result = await executor.submit({
					network: cfg.network, connection: solana.connection, payer: keypair,
					instructions: built.instructions, confirmTimeoutMs: cfg.confirmTimeoutMs, tipMode, onTip,
				});
				sig = result.signature;
				exec = result;
				log.trade('exec', { ...tag, route: result.route, tip: String(result.tipLamports ?? 0n), fee: result.priorityFeeMicroLamports, landed_ms: result.landedMs, attempts: result.attempts, fallback: result.fallbackReason || null });
			}

			const pricePerToken = Number(perTrade) / Number(baseAmount);
			await store.updatePosition(posId, {
				status: 'open', buy_sig: sig,
				entry_quote_lamports: perTrade.toString(),
				base_amount: baseAmount.toString(),
				entry_price_lamports_per_token: pricePerToken,
				entry_price_impact_pct: Number(quote.priceImpactPct),
				peak_value_lamports: Number(perTrade),
				last_value_lamports: Number(perTrade),
				exec_route: exec.route,
				tip_lamports: exec.tipLamports != null ? String(exec.tipLamports) : null,
				priority_fee_microlamports: exec.priorityFeeMicroLamports != null ? String(exec.priorityFeeMicroLamports) : null,
				landed_ms: exec.landedMs ?? null,
				opened_at_ms: Date.now(),
			});
			log.trade('buy', { ...tag, mode: cfg.mode, sig, sol: lamportsToSol(perTrade), base: baseAmount.toString(), impact: Number(quote.priceImpactPct).toFixed(2) });
			screen(`Bought $${symOf(candidate)} at ${lamportsToSol(perTrade).toFixed(4)} SOL — position open`, 'trade');
			safe(() => hooks.onBuy?.({ strategy: strat, candidate, posId, sig, solSpent: lamportsToSol(perTrade), mode: cfg.mode, network: cfg.network }));

			await safeAsync(() => store.recordSpend?.({
				agentId: strat.agent_id, userId: strat.user_id, category: 'snipe', network: cfg.network,
				amountLamports: perTrade, signature: sig !== 'SIMULATED' ? sig : null, mint: candidate.mint,
				status: cfg.mode === 'live' ? 'confirmed' : 'ok',
			}));
			await safeAsync(() => hooks.recordDecision?.(buildDecision({ strat, network: cfg.network, candidate, posId, sig, mode: cfg.mode, priceImpactPct: Number(quote.priceImpactPct), firewall, perTradeLamports: perTrade })));
			return { status: 'open', sig, posId };
		} catch (err) {
			return await fail(store, log, posId, tag, errCode(err), err);
		}
	});
}

/**
 * Close `position` for `reason`. Re-quotes fresh for slippage, builds the sell,
 * broadcasts (live), records realized P&L. A failed sell leaves the position
 * 'open' so the next sweep retries rather than stranding the bag.
 *
 * @param {object} p
 * @param {ReturnType<import('./config.js').loadConfig>} p.cfg
 * @param {import('./types.js').Position} p.position
 * @param {string} p.reason
 * @param {Ports} p.ports
 */
export async function executeSell({ cfg, position, reason, ports }) {
	const { store, wallet, solana, executor, hooks, log } = ports;
	return withAgentLock(position.agent_id, async () => {
		const tag = { agent: position.agent_id, mint: position.mint, symbol: position.symbol, reason };
		const screen = (text, kind, extra) => safe(() => hooks.onScreen?.({ text, kind, ...extra }));
		await store.updatePosition(position.id, { status: 'closing' });
		screen(`Selling $${symOf(position)}: ${reason}`, 'trade');

		try {
			const loaded = await wallet.loadKeypair(position.agent_id, { userId: position.user_id, reason: 'sniper_sell' });
			if (!loaded) {
				await store.updatePosition(position.id, { status: 'open', error: 'no_wallet' });
				return { status: 'retry', reason: 'no_wallet' };
			}
			const { keypair } = loaded;
			const mintPk = new PublicKey(position.mint);
			const baseAmount = BigInt(position.base_amount);
			const slippagePct = (position.slippage_bps ?? 500) / 100;

			const quote = await solana.quoteForSell({ mint: mintPk, baseAmount, slippagePct });
			let expectedOut = BigInt(quote.expectedQuoteOut.toString());
			const built = await solana.buildSellInstructions({ mint: mintPk, user: keypair.publicKey, baseAmount, slippagePct });
			if (built.expectedQuoteOut != null) expectedOut = BigInt(built.expectedQuoteOut.toString());

			let sig = 'SIMULATED';
			if (cfg.mode === 'live') {
				const result = await executor.submit({
					network: cfg.network, connection: solana.connection, payer: keypair,
					instructions: built.instructions, confirmTimeoutMs: cfg.confirmTimeoutMs, tipMode: 'off',
				});
				sig = result.signature;
			}

			const entry = BigInt(position.entry_quote_lamports || '0');
			const pnl = expectedOut - entry;
			const pnlPct = entry > 0n ? (Number(pnl) / Number(entry)) * 100 : 0;
			await store.updatePosition(position.id, {
				status: 'closed', exit_reason: reason, sell_sig: sig,
				exit_quote_lamports: expectedOut.toString(),
				realized_pnl_lamports: pnl.toString(), realized_pnl_pct: pnlPct,
				error: null, closed_at_ms: Date.now(),
			});
			const pnlSol = lamportsToSol(pnl);
			log.trade('sell', { ...tag, mode: cfg.mode, sig, pnl_sol: pnlSol, pnl_pct: pnlPct.toFixed(1) });
			screen(`Sold $${symOf(position)} — ${pnlPct >= 0 ? 'profit' : 'loss'}: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`, 'trade',
				{ phase: 'exit', mint: position.mint, symbol: position.symbol || null, solDelta: pnlSol, pct: pnlPct });
			safe(() => hooks.onSell?.({ position, pnlSol, pnlPct, exitReason: reason, mode: cfg.mode, sig, network: cfg.network }));
			return { status: 'closed', sig, pnl: pnl.toString() };
		} catch (err) {
			await store.updatePosition(position.id, { status: 'open', error: errCode(err) });
			log.warn('sell failed (will retry)', { ...tag, code: errCode(err), err: err?.message });
			screen(`Error: sell $${symOf(position)} failed (${errCode(err)}) — retrying`, 'activity');
			return { status: 'retry', reason: errCode(err) };
		}
	});
}

// Veto hook the executor calls before appending a Jito tip. A tip is real SOL
// leaving the wallet, so it must obey the same daily budget. Throws to veto.
function makeTipGuard({ strat, spentLamports, committedLamports, store, mint }) {
	return async function onTip(tipLamports, route) {
		const tip = BigInt(tipLamports);
		if (tip <= 0n) return;
		if (strat.kill_switch === true) throw Object.assign(new Error('strategy kill switch is on'), { code: 'spend_guard' });
		const budget = BigInt(strat.daily_budget_lamports);
		if (BigInt(spentLamports) + BigInt(committedLamports) + tip > budget) {
			throw Object.assign(new Error('tip would exceed daily budget'), { code: 'spend_guard' });
		}
		await safeAsync(() => store.recordSpend?.({
			agentId: strat.agent_id, userId: strat.user_id, category: 'mev_tip', network: strat.network || 'mainnet',
			amountLamports: tip, signature: null, mint, status: 'confirmed',
		}));
		void route;
	};
}

function buildDecision({ strat, network, candidate, posId, sig, mode, priceImpactPct, firewall, perTradeLamports }) {
	const perTradeSol = Number(BigInt(perTradeLamports)) / 1e9;
	const confidence = snipeConfidence({ priceImpactPct, maxImpactPct: Number(strat.max_price_impact_pct) || 10, firewallVerdict: firewall?.verdict || null });
	const trigger = candidate.entry_trigger || strat.trigger || 'new_mint';
	return {
		agentId: strat.agent_id, kind: 'snipe', subjectRef: candidate.mint, actionRef: String(posId), confidence, network,
		inputs: { entry_trigger: trigger, price_impact_pct: Number(priceImpactPct.toFixed(4)), per_trade_sol: Number(perTradeSol.toFixed(6)), firewall, position_id: posId, buy_sig: sig !== 'SIMULATED' ? sig : null, mode, symbol: candidate.symbol || null },
		prediction: { direction: 'up', basis: 'snipe entry expects a profitable exit', metric: 'realized_pnl' },
		rationale: `Sniped $${symOf(candidate)} on a ${trigger} trigger with ${priceImpactPct.toFixed(2)}% price impact${firewall ? `; firewall ${firewall.verdict} (score ${firewall.score})` : ''}. Committed ${perTradeSol.toFixed(4)} SOL expecting a profitable exit.`,
	};
}

function skip(log, tag, reason) { log.info('skip', { ...tag, reason }); return { status: 'skip', reason }; }
async function fail(store, log, posId, tag, reason, err) {
	await store.updatePosition(posId, { status: 'failed', error: reason, closed_at_ms: Date.now() });
	log.warn('buy aborted', { ...tag, reason, err: err?.message });
	return { status: 'failed', reason };
}
function errCode(err) { return err?.code || err?.name || 'error'; }
function safe(fn) { try { return fn(); } catch { /* best-effort hook */ } }
async function safeAsync(fn) { try { return await fn(); } catch { return null; } }

export { toBN, lamportsToSol };
