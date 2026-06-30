// agent-sniper — custodial Wallet adapter.
//
// For a hosted, multi-tenant deployment where the operator holds (encrypted)
// keys on behalf of users — e.g. three.ws's `agent_identities.encrypted_solana_
// secret`. You supply a single async `resolve(agentId, ctx)` that returns a
// Keypair (decrypting on demand from your own KMS/secret box); this adapter adds
// a short TTL cache so a long-lived process doesn't re-decrypt on every trade.
//
// SECURITY: cache hits keep key material in process memory for up to ttlMs. The
// resolve callback is the right place to write your decrypt audit row — it's
// invoked once per (cold) load, never on a cache hit, which is the correct
// audit semantics (no key left the process on a hit).

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * @param {object} opts
 * @param {(agentId: string, ctx: { userId?: string, reason?: string }) =>
 *   Promise<import('@solana/web3.js').Keypair|null>} opts.resolve
 * @param {number} [opts.ttlMs]
 * @returns {import('../../types.js').Wallet & { clearCache: () => void }}
 */
export function createCustodialWallet(opts) {
	if (typeof opts?.resolve !== 'function') {
		throw new Error('[agent-sniper] createCustodialWallet requires a resolve(agentId, ctx) callback');
	}
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const cache = new Map(); // agentId → { keypair, at }

	return {
		clearCache() { cache.clear(); },

		async loadKeypair(agentId, ctx = {}) {
			const hit = cache.get(agentId);
			if (hit && Date.now() - hit.at < ttlMs) {
				return { keypair: hit.keypair, address: hit.keypair.publicKey.toBase58() };
			}
			const keypair = await opts.resolve(agentId, ctx);
			if (!keypair) return null;
			cache.set(agentId, { keypair, at: Date.now() });
			return { keypair, address: keypair.publicKey.toBase58() };
		},
	};
}

export default createCustodialWallet;
