// agent-sniper — PumpPortal new-token Feed adapter.
//
// Streams pump.fun launches off the public PumpPortal WebSocket
// (wss://pumpportal.fun/api/data) and maps each new-token event into the
// engine's Candidate shape. No auth, no RPC, no Redis — just a socket.
//
// This is the standalone-package twin of three.ws's api/_lib/pumpfun-ws-feed.js,
// rewritten with ZERO three.ws imports so the published @three-ws/agent-sniper
// package carries no internal coupling. It depends only on `ws` (already a
// package dependency) and Node >=20 built-ins.
//
// Contract (src/types.js): a Feed is `{ start(onEvent) => Promise<stopFn> }`.
// `onEvent` receives `{ kind: 'mint', data: Candidate }`. `Candidate.mint` is
// the only required field; we map everything else PumpPortal gives us and omit
// what it doesn't, rather than inventing values.

import WebSocket from 'ws';

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';

// Reconnect backoff: start fast (a transient blip recovers in ~1s), grow
// geometrically so a sustained upstream outage doesn't hammer the endpoint, and
// cap so we never wait absurdly long once it heals.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// Watchdog: PumpPortal occasionally drops a subscription silently — the socket
// stays open but stops delivering events. If we see no message for this long we
// re-send the subscribe payload (and, failing that, the close handler below
// will cycle the socket). 3 min is well past any quiet stretch on a live feed.
const DEFAULT_WATCHDOG_MS = 180_000;

// Solana mainnet quote mints. PumpPortal exposes a quote/pool field on v2 coins;
// only an explicit USDC quote flips `is_usdc_pair`. Anything else (or absent) is
// treated as the native SOL pair, matching the bonding-curve default.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Decide whether a launch is USDC-paired from whatever quote signal the event
 * carries. PumpPortal isn't fully consistent across coin versions, so we probe
 * the handful of fields it has historically used (quoteMint / quote_mint, and
 * the `pool` label on AMM-migrated coins). Returns true only on a positive USDC
 * match — we never guess USDC from absence.
 *
 * @param {object} d raw PumpPortal new-token message
 * @returns {boolean}
 */
function deriveUsdcPair(d) {
	const quoteMint = d.quoteMint || d.quote_mint || null;
	if (quoteMint) return quoteMint === USDC_MINT;
	// Some AMM-pool labels encode the quote asset in the pool name.
	if (typeof d.pool === 'string' && /usdc/i.test(d.pool)) return true;
	return false;
}

/**
 * Map a raw PumpPortal new-token (`txType === 'create'`) message to a Candidate.
 * We only set fields PumpPortal actually delivers on the create event; richer
 * enrichment (creator history, socials) belongs to the engine's intel hooks, not
 * the firehose. `entry_trigger` is always 'mint' here.
 *
 * @param {object} d raw PumpPortal message
 * @returns {import('../../types.js').Candidate}
 */
function toCandidate(d) {
	/** @type {import('../../types.js').Candidate} */
	const c = { mint: d.mint, entry_trigger: 'mint' };

	// Symbol / name — trim and drop empties so the scorer never sees "".
	if (typeof d.symbol === 'string' && d.symbol.trim()) c.symbol = d.symbol.trim();
	if (typeof d.name === 'string' && d.name.trim()) c.name = d.name.trim();

	// PumpPortal reports market cap in SOL (`marketCapSol`); the Candidate field
	// is USD. We have no SOL price on the firehose path here, so we omit
	// market_cap_usd rather than ship an unconverted SOL figure as if it were
	// dollars — a wrong unit is worse than an absent field for the scorer.
	// (The three.ws build enriches with a price feed; the standalone package
	// leaves USD conversion to a price-aware Solana adapter / hook.)

	// The dev's opening buy, in SOL — present on most create events.
	const initialBuy = d.initialBuy ?? d.solAmount;
	if (typeof initialBuy === 'number' && Number.isFinite(initialBuy)) {
		c.initial_buy_sol = initialBuy;
	}

	c.is_usdc_pair = deriveUsdcPair(d);

	return c;
}

/**
 * Create a PumpPortal-backed Feed.
 *
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network='mainnet'] PumpPortal only streams
 *   mainnet; kept for parity with the Feed surface and forward compatibility.
 * @param {string} [opts.url] WebSocket URL (default wss://pumpportal.fun/api/data).
 * @param {number} [opts.watchdogMs=180000] re-subscribe if no message arrives in
 *   this window.
 * @returns {import('../../types.js').Feed}
 */
export function createPumpPortalFeed(opts = {}) {
	const url = opts.url || DEFAULT_URL;
	const watchdogMs = Number.isFinite(opts.watchdogMs) && opts.watchdogMs > 0
		? opts.watchdogMs
		: DEFAULT_WATCHDOG_MS;

	return {
		/**
		 * @param {(e: { kind: string, data: import('../../types.js').Candidate }) => void} onEvent
		 * @returns {Promise<() => void>} stop function
		 */
		async start(onEvent) {
			// `active` gates every async continuation. Once stop() flips it false,
			// late socket events and pending reconnect timers become no-ops, so the
			// feed can't resurrect itself after teardown.
			let active = true;
			let ws = null;
			let reconnectAttempt = 0;
			let reconnectTimer = null;
			let watchdogTimer = null;
			let lastMessageAt = Date.now();

			// Per-feed mint dedupe. PumpPortal can redeliver an event after a WS
			// hiccup or a watchdog re-subscribe; the engine also expects to claim
			// each (agent, mint) slot once, so suppressing duplicates here keeps the
			// buy path clean. Bounded so a long-lived feed never leaks memory.
			const seen = new Set();
			const SEEN_LIMIT = 5_000;
			function firstSight(mint) {
				if (!mint || seen.has(mint)) return false;
				seen.add(mint);
				if (seen.size > SEEN_LIMIT) {
					// Drop the oldest ~20% — Set preserves insertion order.
					const it = seen.values();
					for (let i = 0; i < SEEN_LIMIT / 5; i++) seen.delete(it.next().value);
				}
				return true;
			}

			function sendSubscribe() {
				// Same payload the three.ws feed uses; PumpPortal's documented
				// new-token subscription method.
				try { ws?.send(JSON.stringify({ method: 'subscribeNewToken' })); } catch { /* socket not open */ }
			}

			function armWatchdog() {
				clearInterval(watchdogTimer);
				watchdogTimer = setInterval(() => {
					if (!active) return;
					if (Date.now() - lastMessageAt < watchdogMs) return;
					// Silent stall: nudge the subscription. If the socket is actually
					// dead, the send throws / no-ops and the close path recycles it.
					console.error('[agent-sniper:pumpportal] watchdog: no events, re-subscribing');
					lastMessageAt = Date.now(); // reset so we don't re-fire every tick
					sendSubscribe();
				}, watchdogMs);
				watchdogTimer.unref?.();
			}

			function scheduleReconnect() {
				if (!active) return;
				const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
				reconnectAttempt++;
				clearTimeout(reconnectTimer);
				reconnectTimer = setTimeout(connect, delay);
				reconnectTimer.unref?.();
			}

			function connect() {
				if (!active) return;
				try {
					ws = new WebSocket(url);
				} catch (err) {
					// Constructor can throw on a malformed URL — treat as a connection
					// failure and back off rather than crashing start().
					console.error('[agent-sniper:pumpportal] socket construct failed:', err?.message);
					scheduleReconnect();
					return;
				}

				ws.on('open', () => {
					if (!active) { try { ws.close(); } catch { /* noop */ } return; }
					reconnectAttempt = 0; // healthy connection — reset backoff
					lastMessageAt = Date.now();
					sendSubscribe();
				});

				ws.on('message', (raw) => {
					if (!active) return;
					lastMessageAt = Date.now();
					let msg;
					try { msg = JSON.parse(raw.toString()); } catch { return; }
					if (msg.message) return; // subscription ack, not a token event
					if (msg.txType !== 'create' || !msg.mint) return;
					if (!firstSight(msg.mint)) return;
					const data = toCandidate(msg);
					// Never let a consumer throw bubble up and kill the socket loop.
					try { onEvent({ kind: 'mint', data }); } catch (err) {
						console.error('[agent-sniper:pumpportal] onEvent threw:', err?.message);
					}
				});

				ws.on('error', (err) => {
					// During teardown a mid-handshake socket emits a benign "closed
					// before the connection was established" error — stay quiet for it.
					if (!active) return;
					console.error('[agent-sniper:pumpportal] socket error:', err?.message);
					// `error` is typically followed by `close`; the reconnect is driven
					// from there so we don't double-schedule.
				});

				ws.on('close', () => {
					if (!active) return;
					scheduleReconnect();
				});
			}

			connect();
			armWatchdog();

			// stop(): idempotent teardown. Flip `active` first so no in-flight event
			// or timer can re-arm anything, then clear timers and close the socket.
			return function stop() {
				if (!active) return;
				active = false;
				clearTimeout(reconnectTimer);
				clearInterval(watchdogTimer);
				const sock = ws;
				ws = null;
				if (!sock) return;
				try {
					// Drop listeners so the impending close/error from our own teardown
					// doesn't reschedule or log. terminate() is the hard, immediate kill;
					// fall back to close() if the ws build lacks it.
					sock.removeAllListeners?.('open');
					sock.removeAllListeners?.('message');
					sock.removeAllListeners?.('close');
					sock.removeAllListeners?.('error');
					sock.on?.('error', () => {});
					(sock.terminate ?? sock.close).call(sock);
				} catch { /* already closed */ }
			};
		},
	};
}
