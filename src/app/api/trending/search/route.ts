import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query');

  if (!query) {
    return NextResponse.json({ error: 'Query parameter is required' }, { status: 400 });
  }

  try {
    const response = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(query)}`, {
      headers: {
        'accept': 'application/json',
        'referer': 'https://jup.ag/',
        'user-agent': 'Mozilla/5.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Jupiter API responded with status: ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching token data:', error);
    return NextResponse.json({ error: 'Failed to fetch token data' }, { status: 500 });
  }
}
