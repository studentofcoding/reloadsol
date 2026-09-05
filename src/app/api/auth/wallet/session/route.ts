import { NextRequest, NextResponse, connection } from 'next/server';
import {
  consumeSignInNonce,
  createWalletSignInChallenge,
  verifyWalletSignature,
} from '@/utils/wallet-auth';
import {
  clearWalletSessionCookie,
  createWalletSession,
  getWalletSessionFromRequest,
  setWalletSessionCookie,
} from '@/utils/wallet-session';

export async function GET(req: NextRequest) {
  await connection()
  try {
    const address = req.nextUrl.searchParams.get('address')?.trim();

    if (!address) {
      const session = getWalletSessionFromRequest(req);
      return NextResponse.json({
        success: true,
        authenticated: Boolean(session),
        address: session?.address ?? null,
        dev: session?.dev ?? false,
        expiresAt: session ? new Date(session.exp).toISOString() : null,
      });
    }

    const challenge = createWalletSignInChallenge(address);
    return NextResponse.json({ success: true, ...challenge });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Session check failed',
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const address = String(body.address ?? '').trim();
    const message = String(body.message ?? '');
    const signature = String(body.signature ?? '');

    if (!address || !message || !signature) {
      return NextResponse.json(
        {
          success: false,
          error: 'address, message, and signature are required',
        },
        { status: 400 },
      );
    }

    const verification = verifyWalletSignature({ address, message, signature });
    if (!verification.ok) {
      return NextResponse.json(
        { success: false, error: verification.error },
        { status: 401 },
      );
    }

    if (!(await consumeSignInNonce(verification.nonce))) {
      return NextResponse.json(
        { success: false, error: 'Sign-in nonce already used' },
        { status: 401 },
      );
    }

    const session = createWalletSession(address);
    const response = NextResponse.json({
      success: true,
      address: session.address,
      dev: session.dev,
      expiresAt: new Date(session.exp).toISOString(),
    });
    setWalletSessionCookie(response, session);
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Verification failed',
      },
      { status: 500 },
    );
  }
}

export async function HEAD(req: NextRequest) {
  try {
    const session = getWalletSessionFromRequest(req);
    return NextResponse.json({
      success: true,
      authenticated: Boolean(session),
      address: session?.address ?? null,
      dev: session?.dev ?? false,
      expiresAt: session ? new Date(session.exp).toISOString() : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Session check failed',
      },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  clearWalletSessionCookie(response);
  return response;
}
