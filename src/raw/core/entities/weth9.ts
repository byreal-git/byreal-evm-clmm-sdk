import { Token } from './token.js'

/**
 * Known WETH9 implementation addresses, used in our implementation of Ether#wrapped
 *
 * Deliberately empty: this SDK ships no address book. Consumers register the wrapped native token of
 * their own deployment, e.g. `WETH9[chainId] = new Token(chainId, weth9Address, 18, 'WETH', 'Wrapped Ether')`.
 */
export const WETH9: { [chainId: number]: Token } = {}
