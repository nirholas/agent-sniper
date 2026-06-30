// agent-sniper — default SolanaClient: pump.fun bonding-curve trades.
//
// Wraps @three-ws/agent-payments' PumpTradeClient (an Anchor-backed client over
// the official pump.fun program) so quotes + instruction builds use the same
// battle-tested bonding-curve math the three.ws platform runs in production —
// rather than a re-derivation that could be subtly, expensively wrong.
//
// This is the ONLY adapter that knows pump.fun specifics. Implement the
// SolanaClient contract yourself to route through Jupiter, Raydium, a custom
// program, or a mock for tests.

import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

const RPC = {
	mainnet: () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
	devnet: () => process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com',
};
const WSOL = 'So11111111111111111111111111111111111111112';
const toBN = (v) => new BN(BigInt(v).toString());

/**
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network]
 * @param {string} [opts.rpcUrl]              overrides the network default
 * @param {Connection} [opts.connection]      bring your own
 * @returns {Promise<import('../../types.js').SolanaClient>}
 */
export async function createPumpClient(opts = {}) {
	const network = opts.network || 'mainnet';
	const { PumpTradeClient } = await import('@three-ws/agent-payments');
	const url = opts.rpcUrl || (network === 'devnet' ? RPC.devnet() : RPC.mainnet());
	const connection = opts.connection || new Connection(url, 'confirmed');
	const client = new PumpTradeClient(connection);

	return {
		connection,

		async quoteForBuy({ mint, quoteLamports, slippagePct }) {
			const q = await client.quoteForBuy({ mint, quoteAmount: toBN(quoteLamports), slippagePct });
			return {
				priceImpactPct: Number(q.priceImpactPct ?? 0),
				quoteMint: q.quoteMint || new PublicKey(WSOL),
			};
		},

		async buildBuyInstructions({ mint, user, quoteLamports, slippagePct }) {
			const built = await client.buildBuyInstructions({ mint, user, quoteAmount: toBN(quoteLamports), slippagePct });
			return {
				instructions: built.instructions,
				expectedBaseTokens: BigInt(built.expectedBaseTokens.toString()),
			};
		},

		async quoteForSell({ mint, baseAmount, slippagePct }) {
			const q = await client.quoteForSell({ mint, baseAmount: toBN(baseAmount), slippagePct });
			return { priceImpactPct: Number(q.priceImpactPct ?? 0), expectedQuoteOut: BigInt(q.expectedQuoteOut.toString()) };
		},

		async buildSellInstructions({ mint, user, baseAmount, slippagePct }) {
			const built = await client.buildSellInstructions({ mint, user, baseAmount: toBN(baseAmount), slippagePct });
			return {
				instructions: built.instructions,
				expectedQuoteOut: built.expectedQuoteOut != null ? BigInt(built.expectedQuoteOut.toString()) : undefined,
			};
		},
	};
}

export default createPumpClient;
