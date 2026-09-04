import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { cacheSetNx } from '@/utils/redis-cache';
import {
  buildSignInMessage,
  createSignInNonce,
  parseSignInMessage,
} from '@/utils/wallet-session';

const NONCE_TTL_MS = 10 * 60 * 1000;

export function createWalletSignInChallenge(address: string): {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
} {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const nonce = createSignInNonce();

  return {
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    message: buildSignInMessage({
      address,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }),
  };
}

export async function consumeSignInNonce(nonce: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return false;
  return cacheSetNx(
    `wallet-signin-nonce:${nonce.toLowerCase()}`,
    1,
    Math.ceil(NONCE_TTL_MS / 1000) + 60,
  );
}

export function verifyWalletSignature(input: {
  address: string;
  message: string;
  signature: string;
}): { ok: true; nonce: string } | { ok: false; error: string } {
  const parsed = parseSignInMessage(input.message);
  if (!parsed) {
    return { ok: false, error: 'Invalid sign-in message format' };
  }

  if (parsed.address !== input.address) {
    return { ok: false, error: 'Message address mismatch' };
  }

  const expiresAt = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, error: 'Sign-in message expired' };
  }

  try {
    const publicKey = new PublicKey(input.address).toBytes();
    const messageBytes = new TextEncoder().encode(input.message);
    const signatureBytes = bs58.decode(input.signature);
    const valid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey,
    );

    if (!valid) {
      return { ok: false, error: 'Invalid wallet signature' };
    }

    return { ok: true, nonce: parsed.nonce };
  } catch {
    return { ok: false, error: 'Signature verification failed' };
  }
}
