import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { isDevWallet } from '@/utils/dev-wallet';

export const WALLET_SESSION_COOKIE = 'reloadsol_wallet_session';

export interface WalletSessionPayload {
  address: string;
  dev: boolean;
  iat: number;
  exp: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getSessionSecret(): string {
  const secret = process.env.WALLET_SESSION_SECRET;

  if (!secret) {
    throw new Error('WALLET_SESSION_SECRET must be set');
  }

  return secret;
}

function getSessionTtlMs(): number {
  const hours = Number(process.env.WALLET_SESSION_TTL_HOURS ?? '168');
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_TTL_MS;
  }
  return hours * 60 * 60 * 1000;
}

function encodePayload(payload: WalletSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(encoded: string): WalletSessionPayload | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as WalletSessionPayload;
    if (
      typeof parsed.address !== 'string' ||
      typeof parsed.dev !== 'boolean' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64url');
}

export function createWalletSession(address: string): WalletSessionPayload {
  const now = Date.now();
  return {
    address,
    dev: isDevWallet(address),
    iat: now,
    exp: now + getSessionTtlMs(),
  };
}

export function serializeWalletSession(payload: WalletSessionPayload): string {
  const encoded = encodePayload(payload);
  return `${encoded}.${sign(encoded)}`;
}

export function parseWalletSessionToken(
  token: string | null | undefined,
): WalletSessionPayload | null {
  if (!token) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  const payload = decodePayload(encoded);
  if (!payload || payload.exp <= Date.now()) {
    return null;
  }

  return payload;
}

export function getWalletSessionFromRequest(
  req: NextRequest,
): WalletSessionPayload | null {
  return parseWalletSessionToken(req.cookies.get(WALLET_SESSION_COOKIE)?.value);
}

export function setWalletSessionCookie(
  response: NextResponse,
  payload: WalletSessionPayload,
): void {
  const maxAge = Math.max(0, Math.floor((payload.exp - Date.now()) / 1000));
  response.cookies.set({
    name: WALLET_SESSION_COOKIE,
    value: serializeWalletSession(payload),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearWalletSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: WALLET_SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function createSignInNonce(): string {
  return randomBytes(16).toString('hex');
}

export function buildSignInMessage(input: {
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    'ReloadSOL wallet sign-in',
    `Address: ${input.address}`,
    `Nonce: ${input.nonce}`,
    `Issued: ${input.issuedAt}`,
    `Expires: ${input.expiresAt}`,
  ].join('\n');
}

export function parseSignInMessage(message: string): {
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
} | null {
  const lines = message.split('\n');
  if (lines[0] !== 'ReloadSOL wallet sign-in') return null;

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  if (!fields.Address || !fields.Nonce || !fields.Issued || !fields.Expires) {
    return null;
  }

  return {
    address: fields.Address,
    nonce: fields.Nonce,
    issuedAt: fields.Issued,
    expiresAt: fields.Expires,
  };
}
