'use client';

import bs58 from 'bs58';

type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

type WalletAdapterLike = {
  signMessage?: SignMessageFn;
};

async function signChallenge(
  message: string,
  signMessage?: SignMessageFn,
  adapter?: unknown,
): Promise<string> {
  const encoded = new TextEncoder().encode(message);

  if (signMessage) {
    const signature = await signMessage(encoded);
    return bs58.encode(signature);
  }

  const signer = adapter as WalletAdapterLike | null;
  if (signer?.signMessage) {
    const signature = await signer.signMessage(encoded);
    return bs58.encode(signature);
  }

  throw new Error('This wallet cannot sign messages');
}

export async function establishWalletSession(input: {
  address: string;
  signMessage?: SignMessageFn;
  adapter?: unknown;
}): Promise<{ dev: boolean; expiresAt: string }> {
  const challengeRes = await fetch(
    `/api/auth/wallet/session?address=${encodeURIComponent(input.address)}`,
    { credentials: 'include' },
  );
  const challenge = await challengeRes.json();
  if (!challengeRes.ok || !challenge.success) {
    throw new Error(challenge.error || 'Failed to start wallet sign-in');
  }

  const signature = await signChallenge(
    challenge.message,
    input.signMessage,
    input.adapter,
  );

  const verifyRes = await fetch('/api/auth/wallet/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: input.address,
      message: challenge.message,
      signature,
    }),
  });
  const verified = await verifyRes.json();
  if (!verifyRes.ok || !verified.success) {
    throw new Error(verified.error || 'Wallet sign-in failed');
  }

  return {
    dev: Boolean(verified.dev),
    expiresAt: verified.expiresAt,
  };
}

export async function clearWalletSession(): Promise<void> {
  await fetch('/api/auth/wallet/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

export async function getWalletSessionStatus(): Promise<{
  authenticated: boolean;
  address: string | null;
  dev: boolean;
}> {
  const res = await fetch('/api/auth/wallet/session', {
    credentials: 'include',
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    return { authenticated: false, address: null, dev: false };
  }
  return {
    authenticated: Boolean(data.authenticated),
    address: data.address ?? null,
    dev: Boolean(data.dev),
  };
}

export function canSignMessages(input: {
  signMessage?: SignMessageFn;
  adapter?: unknown;
}): boolean {
  if (input.signMessage) return true;
  const signer = input.adapter as WalletAdapterLike | null;
  return Boolean(signer?.signMessage);
}
