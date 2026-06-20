import { NextResponse } from 'next/server';
import { clearWalletSessionCookie } from '@/utils/wallet-session';

export async function POST() {
  const response = NextResponse.json({ success: true });
  clearWalletSessionCookie(response);
  return response;
}
