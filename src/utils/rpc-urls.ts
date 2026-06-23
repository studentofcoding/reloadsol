import { Connection } from '@solana/web3.js';

const SHYFT_RPC_BASE = 'https://rpc.shyft.to';

export const MAX_RPC_ENDPOINTS = 5;

/** Build a Shyft mainnet RPC URL from an API key. */
export function buildShyftRpcUrl(apiKey: string): string {
  return `${SHYFT_RPC_BASE}?api_key=${apiKey}`;
}

export function isValidRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function sanitizeRpcUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.delete('api-key');
    urlObj.searchParams.delete('api_key');
    urlObj.searchParams.delete('token');
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname !== '/' ? urlObj.pathname : ''}${urlObj.search ? '?***' : ''}`;
  } catch {
    return 'Invalid URL';
  }
}

/** Normalize, dedupe, validate, and cap RPC URLs. */
export function normalizeRpcUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of urls) {
    const url = raw.trim();
    if (!url || !isValidRpcUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
    if (normalized.length >= MAX_RPC_ENDPOINTS) break;
  }

  if (urls.filter((u) => u.trim().length > 0).length > MAX_RPC_ENDPOINTS) {
    console.warn(
      `RPC_URL has more than ${MAX_RPC_ENDPOINTS} endpoints; using the first ${MAX_RPC_ENDPOINTS}.`,
    );
  }

  return normalized;
}

export type RpcEndpointInfo = {
  index: number;
  provider: string;
  sanitizedUrl: string;
  url: string;
};

/** Build indexed endpoint list from URL strings. */
export function buildEndpointList(urls: string[]): RpcEndpointInfo[] {
  return normalizeRpcUrls(urls).map((url, index) => ({
    index,
    provider: getRpcProviderType(url),
    sanitizedUrl: sanitizeRpcUrl(url),
    url,
  }));
}

/** Resolve RPC URL list: RPC_URL env first, else build from SHYFT_API_KEY. */
export function resolveRpcUrls(): string[] {
  const rpcUrl = process.env.RPC_URL;
  if (rpcUrl) {
    const urls = normalizeRpcUrls(
      rpcUrl.split(',').map((url) => url.trim()).filter((url) => url.length > 0),
    );
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
  if (url.includes('mainnet-beta.solana.com')) return 'Solana Public';
  return 'Custom';
}

export function createRpcConnection(commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Connection {
  return new Connection(getPrimaryRpcUrl(), commitment);
}

/** Parse index RPC errors into user-friendly messages. */
export function parseIndexRpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('IndexNotAllowedOnFreePlan') ||
    message.includes('index rpc methods are not allowed')
  ) {
    return 'Index RPC blocked on free plan — add an index-capable RPC to RPC_URL';
  }
  if (message.includes('403')) {
    return 'Index RPC forbidden (403) — try another endpoint in RPC_URL';
  }
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}
