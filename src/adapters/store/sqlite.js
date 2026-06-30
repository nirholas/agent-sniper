// agent-sniper — durable SQLite Store.
//
// A drop-in, durable replacement for the in-memory store (./memory.js): it
// implements the exact same Store contract, so the engine can't tell them apart.
// State survives restarts, which is what multi-run CLI sessions and long-lived
// MCP/API servers need. Backed by better-sqlite3 (an OPTIONAL dependency) —
// synchronous under the hood, wrapped so every method still returns a Promise.
//
// claimPosition is atomic by construction here too: a PARTIAL UNIQUE INDEX on
// (agent_id, mint, network) over non-terminal positions makes the reserving
// INSERT fail on a held slot, so two concurrent processes can't double-buy.
//
// Lamport amounts are bigint in the contract but SQLite has no 64-bit-safe
// integer bind for values > 2^53, and better-sqlite3 throws if you hand it a
// BigInt. So every *_lamports / amount value is stored as TEXT and read back
// with BigInt() / Number() at the boundary.

import { createRequire } from 'node:module';

// better-sqlite3 is a CJS native addon; pull it in via a module-scoped require
// rather than `import` so the dependency stays optional and load failures are
// catchable inside the factory.
const require = createRequire(import.meta.url);

let _seq = 0;
const nextId = () => `pos_${Date.now().toString(36)}_${(++_seq).toString(36)}`;

const startOfUtcDay = (ms) => {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// better-sqlite3 rejects BigInt binds outright and silently lossy-casts large
// Numbers — funnel every lamport-ish value through here on the way in.
const asText = (v) => (v == null ? null : String(v));
const asInt = (v) => (v == null ? null : Number(v));
const asBool = (v) => (v == null ? null : v ? 1 : 0);

// Known position columns (TEXT-stored lamport fields flagged so updatePosition
// and claimPosition coerce them consistently). Anything not here lands in `data`.
const POSITION_LAMPORT_COLS = new Set([
	'entry_quote_lamports',
	'base_amount',
	'peak_value_lamports',
	'last_value_lamports',
	'realized_pnl_lamports',
]);
const POSITION_INT_COLS = new Set([
	'slippage_bps',
	'take_profit_pct',
	'stop_loss_pct',
	'trailing_stop_pct',
	'max_hold_seconds',
	'realized_pnl_pct',
	'opened_at_ms',
	'created_at_ms',
	'closed_at_ms',
]);
const POSITION_TEXT_COLS = new Set([
	'strategy_id',
	'agent_id',
	'user_id',
	'wallet',
	'network',
	'mint',
	'symbol',
	'name',
	'status',
	'entry_trigger',
	'trigger_ref',
	'error',
	'exit_reason',
	'buy_sig',
	'sell_sig',
]);
const POSITION_COLS = new Set([
	'id',
	...POSITION_TEXT_COLS,
	...POSITION_LAMPORT_COLS,
	...POSITION_INT_COLS,
]);

// Reassemble a Position object from its row: typed columns + spread `data`.
function rowToPosition(row) {
	if (!row) return null;
	const extra = row.data ? JSON.parse(row.data) : {};
	const pos = { ...extra };
	pos.id = row.id;
	for (const c of POSITION_TEXT_COLS) if (row[c] != null) pos[c] = row[c];
	for (const c of POSITION_LAMPORT_COLS) if (row[c] != null) pos[c] = BigInt(row[c]);
	for (const c of POSITION_INT_COLS) if (row[c] != null) pos[c] = Number(row[c]);
	return pos;
}

// Strategy round-trips through the `data` column verbatim so unknown/forward
// fields survive; the indexed columns exist only for the armed-set query.
function rowToStrategy(row) {
	if (!row) return null;
	return row.data ? JSON.parse(row.data) : null;
}

function strategyIndexValues(s) {
	return {
		id: s.id,
		agent_id: s.agent_id,
		network: s.network || 'mainnet',
		enabled: asBool(s.enabled),
		kill_switch: asBool(s.kill_switch),
		stop_loss_pct: s.stop_loss_pct == null ? null : Number(s.stop_loss_pct),
		trigger: s.trigger || null,
		data: JSON.stringify(s),
	};
}

/**
 * Durable SQLite-backed Store. Same contract as createMemoryStore().
 *
 * @param {object} [opts]
 * @param {string} [opts.path]  db file path (default $SNIPER_DB_PATH || './agent-sniper.db')
 * @param {import('../../types.js').Strategy[]} [opts.strategies]  seed strategies (upserted)
 * @returns {import('../../types.js').Store & { addStrategy: Function, removeStrategy: Function, close: Function, _db: any }}
 */
export function createSqliteStore(opts = {}) {
	const dbPath = opts.path || process.env.SNIPER_DB_PATH || './agent-sniper.db';

	// Lazy + optional: the package ships without better-sqlite3 by default.
	let Database;
	try {
		Database = require('better-sqlite3');
	} catch {
		throw new Error(
			'better-sqlite3 is required for the sqlite store — install it or use createMemoryStore()'
		);
	}

	const db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	db.exec(`
		CREATE TABLE IF NOT EXISTS strategies (
			id            TEXT PRIMARY KEY,
			agent_id      TEXT NOT NULL,
			network       TEXT,
			enabled       INTEGER,
			kill_switch   INTEGER,
			stop_loss_pct REAL,
			trigger       TEXT,
			data          TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_strategies_armed
			ON strategies(network, enabled, kill_switch);

		CREATE TABLE IF NOT EXISTS positions (
			id                     TEXT PRIMARY KEY,
			strategy_id            TEXT,
			agent_id               TEXT NOT NULL,
			user_id                TEXT,
			wallet                 TEXT,
			network                TEXT NOT NULL,
			mint                   TEXT NOT NULL,
			symbol                 TEXT,
			name                   TEXT,
			status                 TEXT NOT NULL,
			entry_quote_lamports   TEXT,
			base_amount            TEXT,
			peak_value_lamports    TEXT,
			last_value_lamports    TEXT,
			slippage_bps           INTEGER,
			take_profit_pct        INTEGER,
			stop_loss_pct          INTEGER,
			trailing_stop_pct      INTEGER,
			max_hold_seconds       INTEGER,
			entry_trigger          TEXT,
			trigger_ref            TEXT,
			error                  TEXT,
			exit_reason            TEXT,
			realized_pnl_lamports  TEXT,
			realized_pnl_pct       INTEGER,
			buy_sig                TEXT,
			sell_sig               TEXT,
			opened_at_ms           INTEGER,
			created_at_ms          INTEGER,
			closed_at_ms           INTEGER,
			data                   TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_positions_agent_net
			ON positions(agent_id, network, status);
		CREATE INDEX IF NOT EXISTS idx_positions_net_status
			ON positions(network, status);
		-- The double-buy guard: only one live position per (agent, mint, network).
		CREATE UNIQUE INDEX IF NOT EXISTS uniq_positions_live_slot
			ON positions(agent_id, mint, network)
			WHERE status NOT IN ('closed', 'failed');

		CREATE TABLE IF NOT EXISTS spend (
			agent_id        TEXT NOT NULL,
			network         TEXT NOT NULL,
			amount_lamports TEXT NOT NULL,
			category        TEXT,
			at              INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_spend_agent_net
			ON spend(agent_id, network, at);
	`);

	const stmtUpsertStrategy = db.prepare(`
		INSERT INTO strategies (id, agent_id, network, enabled, kill_switch, stop_loss_pct, trigger, data)
		VALUES (@id, @agent_id, @network, @enabled, @kill_switch, @stop_loss_pct, @trigger, @data)
		ON CONFLICT(id) DO UPDATE SET
			agent_id      = excluded.agent_id,
			network       = excluded.network,
			enabled       = excluded.enabled,
			kill_switch   = excluded.kill_switch,
			stop_loss_pct = excluded.stop_loss_pct,
			trigger       = excluded.trigger,
			data          = excluded.data
	`);
	const stmtDeleteStrategy = db.prepare('DELETE FROM strategies WHERE id = ?');
	const stmtArmedStrategies = db.prepare(`
		SELECT data FROM strategies
		WHERE enabled = 1
		  AND (kill_switch IS NULL OR kill_switch = 0)
		  AND network = ?
		  AND stop_loss_pct IS NOT NULL
	`);
	const stmtCountOpen = db.prepare(`
		SELECT COUNT(*) AS n FROM positions
		WHERE agent_id = ? AND network = ? AND status IN ('open', 'opening')
	`);
	const stmtDailySpend = db.prepare(`
		SELECT amount_lamports FROM spend
		WHERE agent_id = ? AND network = ? AND at >= ?
	`);
	const stmtGetPosition = db.prepare('SELECT * FROM positions WHERE id = ?');
	const stmtOpenPositions = db.prepare(`
		SELECT * FROM positions
		WHERE network = ? AND status IN ('open', 'closing')
	`);
	const stmtRecordSpend = db.prepare(`
		INSERT INTO spend (agent_id, network, amount_lamports, category, at)
		VALUES (@agent_id, @network, @amount_lamports, @category, @at)
	`);

	function upsertStrategy(s) {
		stmtUpsertStrategy.run(strategyIndexValues(s));
		return s;
	}

	for (const s of opts.strategies || []) upsertStrategy(s);

	return {
		_db: db,
		close() { db.close(); },
		addStrategy(s) { return upsertStrategy(s); },
		removeStrategy(id) { return stmtDeleteStrategy.run(id).changes > 0; },

		async getArmedStrategies(network) {
			return stmtArmedStrategies.all(network).map(rowToStrategy).filter(Boolean);
		},

		async countOpenPositions(agentId, network) {
			return stmtCountOpen.get(agentId, network).n;
		},

		async getDailySpendLamports(agentId, network) {
			const dayStart = startOfUtcDay(Date.now());
			let total = 0n;
			for (const row of stmtDailySpend.all(agentId, network, dayStart)) {
				total += BigInt(row.amount_lamports);
			}
			return total;
		},

		async claimPosition({ strategy, candidate, network }) {
			const row = {
				id: nextId(),
				strategy_id: strategy.id,
				agent_id: strategy.agent_id,
				user_id: strategy.user_id ?? null,
				wallet: 'pending',
				network,
				mint: candidate.mint,
				symbol: candidate.symbol || null,
				name: candidate.name || null,
				status: 'opening',
				entry_quote_lamports: null,
				base_amount: null,
				peak_value_lamports: null,
				last_value_lamports: null,
				slippage_bps: asInt(strategy.slippage_bps ?? 500),
				take_profit_pct: asInt(strategy.take_profit_pct ?? null),
				stop_loss_pct: asInt(strategy.stop_loss_pct),
				trailing_stop_pct: asInt(strategy.trailing_stop_pct ?? null),
				max_hold_seconds: asInt(strategy.max_hold_seconds ?? 1800),
				entry_trigger: candidate.entry_trigger || strategy.trigger || 'new_mint',
				trigger_ref: candidate.trigger_ref || null,
				error: null,
				exit_reason: null,
				realized_pnl_lamports: null,
				realized_pnl_pct: null,
				buy_sig: null,
				sell_sig: null,
				opened_at_ms: null,
				created_at_ms: Date.now(),
				closed_at_ms: null,
				data: null,
			};
			try {
				db.prepare(`
					INSERT INTO positions (
						id, strategy_id, agent_id, user_id, wallet, network, mint, symbol, name, status,
						entry_quote_lamports, base_amount, peak_value_lamports, last_value_lamports,
						slippage_bps, take_profit_pct, stop_loss_pct, trailing_stop_pct, max_hold_seconds,
						entry_trigger, trigger_ref, error, exit_reason, realized_pnl_lamports, realized_pnl_pct,
						buy_sig, sell_sig, opened_at_ms, created_at_ms, closed_at_ms, data
					) VALUES (
						@id, @strategy_id, @agent_id, @user_id, @wallet, @network, @mint, @symbol, @name, @status,
						@entry_quote_lamports, @base_amount, @peak_value_lamports, @last_value_lamports,
						@slippage_bps, @take_profit_pct, @stop_loss_pct, @trailing_stop_pct, @max_hold_seconds,
						@entry_trigger, @trigger_ref, @error, @exit_reason, @realized_pnl_lamports, @realized_pnl_pct,
						@buy_sig, @sell_sig, @opened_at_ms, @created_at_ms, @closed_at_ms, @data
					)
				`).run(row);
			} catch (err) {
				// Partial-unique violation ⇒ a live slot is already held: skip, no double buy.
				if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
				throw err;
			}
			return rowToPosition(stmtGetPosition.get(row.id));
		},

		async updatePosition(id, patch) {
			const cur = stmtGetPosition.get(id);
			if (!cur) return;

			const sets = [];
			const params = {};
			const extra = cur.data ? JSON.parse(cur.data) : {};
			let extraTouched = false;

			for (const [key, val] of Object.entries(patch)) {
				if (key === 'id') continue; // PK is immutable
				if (POSITION_COLS.has(key)) {
					sets.push(`${key} = @${key}`);
					if (POSITION_LAMPORT_COLS.has(key)) params[key] = asText(val);
					else if (POSITION_INT_COLS.has(key)) params[key] = asInt(val);
					else params[key] = val == null ? null : String(val);
				} else {
					// Unknown patch key → merge into the JSON sidecar (bigints → strings).
					extra[key] = typeof val === 'bigint' ? String(val) : val;
					extraTouched = true;
				}
			}

			if (extraTouched) {
				sets.push('data = @data');
				params.data = JSON.stringify(extra);
			}
			if (!sets.length) return;

			params.id = id;
			db.prepare(`UPDATE positions SET ${sets.join(', ')} WHERE id = @id`).run(params);
		},

		async getOpenPositions(network) {
			return stmtOpenPositions.all(network).map(rowToPosition);
		},

		async recordSpend(e) {
			stmtRecordSpend.run({
				agent_id: e.agentId,
				network: e.network,
				amount_lamports: String(e.amountLamports),
				category: e.category || null,
				at: Date.now(),
			});
		},

		/** Convenience for faces (MCP/API/CLI): list positions for an agent. */
		async listPositions({ agentId, network, status } = {}) {
			const where = [];
			const args = [];
			if (agentId) { where.push('agent_id = ?'); args.push(agentId); }
			if (network) { where.push('network = ?'); args.push(network); }
			if (status) { where.push('status = ?'); args.push(status); }
			const sql = `SELECT * FROM positions${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
			return db.prepare(sql).all(...args).map(rowToPosition);
		},
	};
}

export default createSqliteStore;
