# RPC Security Migration

## Overview
Successfully migrated RPC configuration to use server-side environment variables only, eliminating the need for `NEXT_PUBLIC_RPC_URL` and preventing private RPC endpoints from being exposed in the client bundle.

## Changes Made

### 1. **Environment Variable Security**
- **Before:** Client code accessed `process.env.RPC_URL` (undefined) → fallback to `process.env.NEXT_PUBLIC_RPC_URL`
- **After:** Server uses private `process.env.RPC_URL`, client uses placeholder URLs

### 2. **Connection Architecture**
```typescript
// Server-side (API routes)
const rpcUrls = getServerRpcUrls() // Uses process.env.RPC_URL
const connection = new Connection(rpcUrls[0])

// Client-side (React components)  
const rpcUrls = getClientRpcUrls() // Returns placeholder URLs
const connection = new Connection('https://placeholder-rpc.solana.com')
```

### 3. **Client-Side RPC Requests**
All client-side RPC operations now use the API proxy:

```typescript
// OLD: Direct RPC (exposed private URLs)
const response = await fetch(rpcUrl, { method: 'POST', body: rpcRequest })

// NEW: API Proxy (secure)
import { makeClientRpcRequest } from '@/utils/rpc-config'
const response = await makeClientRpcRequest(rpcRequest)
```

## Usage Guide

### **Server-Side (API Routes)**
```typescript
// Direct connection works normally
import { createConnection } from '@/utils/connection'
const connection = createConnection('mainnet')
const slot = await connection.getSlot()
```

### **Client-Side (React Components)**
```typescript
// For basic Solana operations, use the connection normally
import { useConnection } from './WalletProvider'
const { connection } = useConnection()
const slot = await connection.getSlot() // Automatically proxied

// For custom RPC requests, use the proxy explicitly
import { makeClientRpcRequest } from '@/utils/rpc-config'
const result = await makeClientRpcRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'getAccountInfo',
  params: [publicKey.toString()]
})
```

### **Health Monitoring**
```typescript
import { getRpcHealth } from '@/utils/rpc-config'
const healthData = await getRpcHealth()
```

## API Endpoints

### **GET /api/rpc/health**
Health check for all configured RPC endpoints
```json
{
  "status": "success",
  "summary": { "healthy": 2, "unhealthy": 0 },
  "endpoints": [...]
}
```

### **POST /api/rpc**
Proxy for RPC requests with automatic failover
```bash
curl -X POST /api/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
```

### **GET /api/rpc/config**
Configuration overview (sanitized URLs)
```json
{
  "configuration": {
    "total_endpoints": 3,
    "endpoints": [{"url": "https://helius-rpc.com?***"}]
  }
}
```

## Environment Setup

### **Required (Server-Side Only)**
```bash
# Private RPC endpoints (comma-separated)
RPC_URL=https://premium-rpc1.com?api_key=secret,https://premium-rpc2.com?token=secret
```

### **No Longer Needed**
```bash
# REMOVED: No longer needed with proxy system
# NEXT_PUBLIC_RPC_URL=...
```

## Security Benefits

✅ **Private Credentials Protected**: RPC API keys never exposed in client bundle  
✅ **Automatic Failover**: Built-in redundancy across multiple RPC providers  
✅ **Rate Limiting**: Server-side control over RPC request patterns  
✅ **Caching**: Intelligent endpoint health caching reduces latency  
✅ **Monitoring**: Comprehensive health checking and error logging  

## Migration Impact

- **✅ Build Success**: No more "RPC_URL is required" errors during build
- **✅ Security**: Private RPC endpoints never exposed to client
- **✅ Performance**: Intelligent endpoint selection and caching
- **✅ Reliability**: Automatic failover between healthy endpoints
- **✅ Compatibility**: Existing Solana operations continue to work seamlessly

The system now uses private environment variables server-side only, with all client-side RPC operations proxied through secure API routes. 