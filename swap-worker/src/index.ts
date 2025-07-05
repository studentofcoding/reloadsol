import { NATIVE_MINT } from '@solana/spl-token'

interface Env {
  DEV_FEE_WALLET: string
  FLUXBEAM_KEY: string
}

interface TrackerResponse {
  txn: string
  success?: boolean
  error?: string
}

// Validate if origin is from reloadsol.xyz domain
function isValidOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return false
  
  try {
    const url = new URL(origin)
    return url.hostname.endsWith('reloadsol.xyz')
  } catch {
    return false
  }
}

async function buildTxn(body: any, env: Env): Promise<string> {
  const apiBody = {
    from: body.direction === 'buy' ? NATIVE_MINT.toBase58() : body.mint,
    to:   body.direction === 'buy' ? body.mint : NATIVE_MINT.toBase58(),
    amount: body.amount,                 // already in SOL units
    slippage: body.slippage,             // 0.5 = 0.5 %
    payer: body.payer,
    priorityFee: body.priorityFee,       // SOL units
    fee: `${env.DEV_FEE_WALLET}:0.5`
  }

  const r = await fetch('https://swap-v2.solanatracker.io/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' },
    body: JSON.stringify(apiBody)
  })
  
  if (!r.ok) {
    const errorText = await r.text()
    throw new Error(`Tracker ${r.status}: ${errorText}`)
  }
  
  const result = await r.json() as TrackerResponse
  
  if (!result.txn) {
    throw new Error('No transaction returned from swap API')
  }
  
  return result.txn
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const corsHeaders = {
      'Access-Control-Allow-Origin': isValidOrigin(request) ? origin! : '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin', // Important when varying response based on Origin
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }
    
    // Validate request origin
    if (!isValidOrigin(request)) {
      return new Response('Forbidden: Invalid origin', { 
        status: 403,
        headers: corsHeaders
      })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { 
        status: 405,
        headers: corsHeaders
      })
    }
    
    try {
      const body = await request.json()
      const txn = await buildTxn(body, env)
      
      return Response.json({ txn }, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      })
    } catch (err: any) {
      console.error('Swap error:', err)
      return Response.json(
        { error: err.message || 'swap error' }, 
        { 
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }
  }
}