import { Connection } from '@solana/web3.js';

const SHYFT_RPC_BASE = 'https://rpc.shyft.to';

/** Build a Shyft mainnet RPC URL from an API key. */
export function buildShyftRpcUrl(apiKey: string): string {
  return `${SHYFT_RPC_BASE}?api_key=${apiKey}`;
}

/** Resolve RPC URL list: RPC_URL env first, else build from SHYFT_API_KEY. */
export function resolveRpcUrls(): string[] {
  const rpcUrl = process.env.RPC_URL;
  if (rpcUrl) {
    const urls = rpcUrl
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    if (urls.length > 0) return urls;
  }

  const shyftKey = process.env.SHYFT_API_KEY;
  if (shyftKey && shyftKey !== 'your-shyft-api-key') {
    return [buildShyftRpcUrl(shyftKey)];
  }

  return [];
}

export function getPrimaryRpcUrl(): string {
  const urls = resolveRpcUrls();
  if (urls.length === 0) {
    throw new Error(
      'RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env (https://rpc.shyft.to?api_key=...)',
    );
  }
  return urls[0];
}

/** Client-safe RPC URL for Jupiter Terminal / wallet (browser). */
export function getPublicRpcUrl(): string {
  if (process.env.NEXT_PUBLIC_RPC_URL) {
    return process.env.NEXT_PUBLIC_RPC_URL;
  }
  return getPrimaryRpcUrl();
}

export function getRpcProviderType(url: string): string {
  if (url.includes('shyft')) return 'Shyft';
  if (url.includes('helius')) return 'Helius';
  if (url.includes('extrnode')) return 'Extrnode';
  if (url.includes('projectserum')) return 'Project Serum';
  return 'Custom';
}

export function createRpcConnection(commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Connection {
  return new Connection(getPrimaryRpcUrl(), commitment);
}
