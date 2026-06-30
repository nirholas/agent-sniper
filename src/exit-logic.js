// agent-sniper — exit decision. Pure, no I/O.
//
// Given a position, its current on-chain value, the high-water mark, the clock,
// and an optional sentiment read, decide whether to close — and why. Evaluated
// in a fixed priority order so the reason is deterministic and explainable:
//   stop-loss → trailing-stop → take-profit → timeout → sentiment-flip.
//
// Returns an exit-reason string, or null to hold.

function num(v, def = null) {
	if (v == null || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}

/**
 * @param {import('./types.js').Position} pos
 * @param {number} value   current value of the position in lamports
 * @param {number} peak    high-water mark in lamports (>= value seen so far)
 * @param {number} nowMs   Date.now()
 * @param {{ signal: string, confidence: number|null, minConfidence: number }|null} [sentiment]
 * @returns {string|null}
 */
export function decideExit(pos, value, peak, nowMs, sentiment = null) {
	const entry = num(pos.entry_quote_lamports, 0) || 0;
	if (entry <= 0) return null;

	const pnlPct = ((value - entry) / entry) * 100;

	// ── stop-loss (mandatory) ────────────────────────────────────────────────
	const stop = num(pos.stop_loss_pct);
	if (stop != null && pnlPct <= -Math.abs(stop)) return 'stop_loss';

	// ── trailing-stop: drawdown from the peak ────────────────────────────────
	const trail = num(pos.trailing_stop_pct);
	if (trail != null && peak > 0) {
		const dropFromPeakPct = ((peak - value) / peak) * 100;
		// Only arms once the position has been in profit at least the trail amount,
		// so a coin that never moves up can't trail-stop on entry noise.
		if (peak > entry && dropFromPeakPct >= Math.abs(trail)) return 'trailing_stop';
	}

	// ── take-profit ──────────────────────────────────────────────────────────
	const tp = num(pos.take_profit_pct);
	if (tp != null && pnlPct >= Math.abs(tp)) return 'take_profit';

	// ── timeout ──────────────────────────────────────────────────────────────
	const maxHold = num(pos.max_hold_seconds);
	const openedAt = num(pos.opened_at_ms);
	if (maxHold != null && openedAt != null && nowMs - openedAt >= maxHold * 1000) {
		return 'timeout';
	}

	// ── sentiment flip (opt-in, only meaningful while underwater) ─────────────
	if (sentiment && value < entry && sentiment.signal === 'bearish') {
		const conf = num(sentiment.confidence);
		if (conf != null && conf >= sentiment.minConfidence) return 'signal_flip';
	}

	return null;
}
