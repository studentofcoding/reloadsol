'use client';

import bs58 from 'bs58';

type WalletAdapterLike = {
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
};

async function signWithAdapter(
  adapter: unknown,
  message: string,
): Promise<string> {
  const signer = adapter as WalletAdapterLike | null;
  if (!signer?.signMessage) {
    throw new Error('Wallet does not support message signing');
  }

  const encoded = new TextEncoder().encode(message);
  const signature = await signer.signMessage(encoded);
  return bs58.encode(signature);
}

export async function establishWalletSession(input: {
  address: string;
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

  if (!input.adapter) {
    throw new Error('Wallet adapter unavailable');
  }

  const signature = await signWithAdapter(input.adapter, challenge.message);

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
    method: 'HEAD',
    credentials: 'include',
  });
  const data = await res.json();
  return {
    authenticated: Boolean(data.authenticated),
    address: data.address ?? null,
    dev: Boolean(data.dev),
  };
}
