// agent-sniper — in-memory Store.
//
// The reference Store implementation and the zero-config default. Holds
// strategies + positions in process memory; nothing survives a restart. Perfect
// for simulate mode, tests, and single-run CLI sessions. For durable multi-run
// state use the sqlite store (./sqlite.js) — it implements the same contract.
//
// claimPosition is atomic by construction: JS is single-threaded, so the
// check-then-insert on (agent_id, mint, network) can't interleave.

let _seq = 0;
const nextId = () => `pos_${Date.now().toString(36)}_${(++_seq).toString(36)}`;

const startOfUtcDay = (ms) => {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * @param {object} [seed]
 * @param {import('../../types.js').Strategy[]} [seed.strategies]
 * @returns {import('../../types.js').Store & { addStrategy: Function, _positions: Map, _spend: any[] }}
 */
export function createMemoryStore(seed = {}) {
	/** @type {Map<string, import('../../types.js').Strategy>} */
	const strategies = new Map();
	/** @type {Map<string, import('../../types.js').Position>} */
	const positions = new Map();
	/** @type {Array<{ agentId: string, network: string, amountLamports: bigint, at: number, category: string }>} */
	const spend = [];

	for (const s of seed.strategies || []) strategies.set(s.id, { ...s });

	const slotKey = (agentId, mint, network) => `${agentId}::${mint}::${network}`;

	return {
		addStrategy(s) { strategies.set(s.id, { ...s }); return s; },
		removeStrategy(id) { return strategies.delete(id); },
		_positions: positions,
		_spend: spend,

		async getArmedStrategies(network) {
			const out = [];
			for (const s of strategies.values()) {
				if (!s.enabled || s.kill_switch) continue;
				if ((s.network || 'mainnet') !== network) continue;
				if (s.stop_loss_pct == null) continue; // mandatory stop-loss
				out.push({ ...s });
			}
			return out;
		},

		async countOpenPositions(agentId, network) {
			let n = 0;
			for (const p of positions.values()) {
				if (p.agent_id === agentId && p.network === network && (p.status === 'open' || p.status === 'opening')) n++;
			}
			return n;
		},

		async getDailySpendLamports(agentId, network) {
			const dayStart = startOfUtcDay(Date.now());
			let total = 0n;
			for (const e of spend) {
				if (e.agentId === agentId && e.network === network && e.at >= dayStart) total += BigInt(e.amountLamports);
			}
			return total;
		},

		async claimPosition({ strategy, candidate, network }) {
			const key = slotKey(strategy.agent_id, candidate.mint, network);
			for (const p of positions.values()) {
				if (slotKey(p.agent_id, p.mint, p.network) === key && p.status !== 'closed' && p.status !== 'failed') {
					return null; // slot already held
				}
			}
			const pos = {
				id: nextId(),
				strategy_id: strategy.id,
				agent_id: strategy.agent_id,
				user_id: strategy.user_id,
				wallet: 'pending',
				network,
				mint: candidate.mint,
				symbol: candidate.symbol || null,
				name: candidate.name || null,
				status: 'opening',
				entry_trigger: candidate.entry_trigger || strategy.trigger || 'new_mint',
				trigger_ref: candidate.trigger_ref || null,
				slippage_bps: strategy.slippage_bps ?? 500,
				take_profit_pct: strategy.take_profit_pct ?? null,
				stop_loss_pct: strategy.stop_loss_pct,
				trailing_stop_pct: strategy.trailing_stop_pct ?? null,
				max_hold_seconds: strategy.max_hold_seconds ?? 1800,
				created_at_ms: Date.now(),
			};
			positions.set(pos.id, pos);
			return { ...pos };
		},

		async updatePosition(id, patch) {
			const cur = positions.get(id);
			if (!cur) return;
			positions.set(id, { ...cur, ...patch });
		},

		async getOpenPositions(network) {
			const out = [];
			for (const p of positions.values()) {
				if (p.network !== network) continue;
				if (p.status === 'open' || p.status === 'closing') out.push({ ...p });
			}
			return out;
		},

		async recordSpend(e) {
			spend.push({ agentId: e.agentId, network: e.network, amountLamports: BigInt(e.amountLamports), at: Date.now(), category: e.category });
		},

		/** Convenience for faces (MCP/API/CLI): list positions for an agent. */
		async listPositions({ agentId, network, status } = {}) {
			const out = [];
			for (const p of positions.values()) {
				if (agentId && p.agent_id !== agentId) continue;
				if (network && p.network !== network) continue;
				if (status && p.status !== status) continue;
				out.push({ ...p });
			}
			return out;
		},
	};
}

export default createMemoryStore;
