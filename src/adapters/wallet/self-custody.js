// agent-sniper — self-custodial Wallet adapter.
//
// Keys never leave the machine. Each agent maps to a local ed25519 Keypair,
// loaded from (in priority order):
//   1. an in-memory map passed to the constructor (agentId → secret)
//   2. SNIPER_WALLET_<AGENTID> env (base58 or JSON array secret key)
//   3. a keystore directory of `<agentId>.json` files (Solana CLI keypair format)
//   4. a single default keypair (SOLANA_SECRET_KEY / --keypair) for one-agent runs
//
// Accepts base58 strings, JSON byte arrays (`[12,34,...]`), and 0x-hex secrets.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function decodeSecret(raw) {
	if (!raw) return null;
	const s = String(raw).trim();
	try {
		if (s.startsWith('[')) {
			const arr = Uint8Array.from(JSON.parse(s));
			return Keypair.fromSecretKey(arr);
		}
		if (s.startsWith('0x')) {
			const bytes = Uint8Array.from(Buffer.from(s.slice(2), 'hex'));
			return Keypair.fromSecretKey(bytes);
		}
		return Keypair.fromSecretKey(bs58.decode(s));
	} catch (err) {
		throw new Error(`[agent-sniper] could not decode wallet secret: ${err.message}`);
	}
}

function envKeyFor(agentId) {
	// SNIPER_WALLET_<AGENTID> with non-alphanumerics → underscore, uppercased.
	return `SNIPER_WALLET_${String(agentId).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
}

/**
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.secrets]   agentId → secret (base58/json/hex)
 * @param {string} [opts.keystoreDir]               dir of <agentId>.json keypairs
 * @param {string} [opts.defaultSecret]             fallback secret for any agentId (single-wallet mode)
 * @returns {import('../../types.js').Wallet}
 */
export function createSelfCustodyWallet(opts = {}) {
	const cache = new Map(); // agentId → Keypair
	const inline = new Map(Object.entries(opts.secrets || {}));
	const keystoreDir = opts.keystoreDir || process.env.SNIPER_KEYSTORE_DIR || null;
	const defaultSecret = opts.defaultSecret || process.env.SOLANA_SECRET_KEY || null;

	function resolve(agentId) {
		if (cache.has(agentId)) return cache.get(agentId);

		let kp = null;
		if (inline.has(agentId)) kp = decodeSecret(inline.get(agentId));
		if (!kp && process.env[envKeyFor(agentId)]) kp = decodeSecret(process.env[envKeyFor(agentId)]);
		if (!kp && keystoreDir) {
			const file = path.join(keystoreDir, `${agentId}.json`);
			if (fs.existsSync(file)) kp = decodeSecret(fs.readFileSync(file, 'utf8'));
		}
		if (!kp && defaultSecret) kp = decodeSecret(defaultSecret);

		if (kp) cache.set(agentId, kp);
		return kp;
	}

	return {
		async loadKeypair(agentId) {
			const keypair = resolve(agentId);
			if (!keypair) return null;
			return { keypair, address: keypair.publicKey.toBase58() };
		},
	};
}

export default createSelfCustodyWallet;
