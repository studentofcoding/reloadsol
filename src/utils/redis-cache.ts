import Redis from 'ioredis'

interface MemoryEntry {
  value: string
  expiresAt: number
}

const memoryFallback = new Map<string, MemoryEntry>()
let redisClient: Redis | null = null
let redisDisabled = false
let redisUnavailableLogged = false

function getRedisUrl(): string | undefined {
  return process.env.REDIS_URL?.trim() || undefined
}

function getRedisClient(): Redis | null {
  if (redisDisabled || !getRedisUrl()) {
    return null
  }

  if (!redisClient) {
    redisClient = new Redis(getRedisUrl()!, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    })

    redisClient.on('error', (error) => {
      if (!redisUnavailableLogged) {
        console.warn('[redis-cache] Redis unavailable, using memory fallback:', error.message)
        redisUnavailableLogged = true
      }
    })
  }

  return redisClient
}

function memoryGet(key: string): string | null {
  const entry = memoryFallback.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    memoryFallback.delete(key)
    return null
  }
  return entry.value
}

function memorySet(key: string, value: string, ttlSeconds: number): void {
  memoryFallback.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  })
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedisClient()

  if (client) {
    try {
      if (client.status === 'wait') {
        await client.connect()
      }
      const raw = await client.get(key)
      if (raw != null) {
        memorySet(key, raw, 60)
        return JSON.parse(raw) as T
      }
    } catch {
      redisDisabled = true
    }
  }

  const mem = memoryGet(key)
  if (mem == null) return null

  try {
    return JSON.parse(mem) as T
  } catch {
    memoryFallback.delete(key)
    return null
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const serialized = JSON.stringify(value)
  memorySet(key, serialized, ttlSeconds)

  const client = getRedisClient()
  if (!client) return

  try {
    if (client.status === 'wait') {
      await client.connect()
    }
    await client.set(key, serialized, 'EX', ttlSeconds)
  } catch {
    redisDisabled = true
  }
}

export async function cacheDel(keys: string | string[]): Promise<void> {
  const keyList = Array.isArray(keys) ? keys : [keys]
  keyList.forEach((key) => memoryFallback.delete(key))

  const client = getRedisClient()
  if (!client || keyList.length === 0) return

  try {
    if (client.status === 'wait') {
      await client.connect()
    }
    await client.del(...keyList)
  } catch {
    redisDisabled = true
  }
}

export async function cacheDelByPrefix(prefix: string): Promise<void> {
  for (const key of Array.from(memoryFallback.keys())) {
    if (key.startsWith(prefix)) {
      memoryFallback.delete(key)
    }
  }

  const client = getRedisClient()
  if (!client) return

  try {
    if (client.status === 'wait') {
      await client.connect()
    }
    let cursor = '0'
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        100,
      )
      cursor = nextCursor
      if (keys.length > 0) {
        await client.del(...keys)
      }
    } while (cursor !== '0')
  } catch {
    redisDisabled = true
  }
}
