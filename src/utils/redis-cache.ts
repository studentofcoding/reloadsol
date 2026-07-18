import Redis from 'ioredis'

interface MemoryEntry {
  value: string
  expiresAt: number
}

const memoryFallback = new Map<string, MemoryEntry>()
let redisClient: Redis | null = null
let redisDisabled = false
let redisUnavailableLogged = false
/** Separate connection for SUBSCRIBE (ioredis requirement). */
let redisSubClient: Redis | null = null
let redisSubDisabled = false

function getRedisUrl(): string | undefined {
  return process.env.REDIS_URL?.trim() || undefined
}

async function ensureConnected(client: Redis): Promise<boolean> {
  try {
    if (client.status === 'wait') {
      await client.connect()
    }
    return true
  } catch {
    return false
  }
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

function getRedisSubClient(): Redis | null {
  if (redisSubDisabled || redisDisabled || !getRedisUrl()) {
    return null
  }

  if (!redisSubClient) {
    redisSubClient = new Redis(getRedisUrl()!, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    redisSubClient.on('error', (error) => {
      console.warn('[redis-cache] Redis subscriber error:', error.message)
      redisSubDisabled = true
    })
  }

  return redisSubClient
}

/** Publish JSON on a channel. No-op if Redis unavailable. */
export async function publishJson(
  channel: string,
  payload: unknown,
): Promise<void> {
  const client = getRedisClient()
  if (!client) return
  try {
    if (!(await ensureConnected(client))) return
    await client.publish(channel, JSON.stringify(payload))
  } catch {
    // leave command client alone; pub is best-effort
  }
}

/**
 * Subscribe to a JSON channel. Returns unsubscribe fn.
 * Uses a dedicated Redis connection. No-op unsubscribe if Redis unavailable.
 */
export async function subscribeJson(
  channel: string,
  handler: (payload: unknown) => void,
): Promise<() => void> {
  const client = getRedisSubClient()
  if (!client) {
    return () => undefined
  }

  const onMessage = (ch: string, message: string) => {
    if (ch !== channel) return
    try {
      handler(JSON.parse(message) as unknown)
    } catch {
      // ignore bad payloads
    }
  }

  try {
    if (!(await ensureConnected(client))) {
      return () => undefined
    }
    await client.subscribe(channel)
    client.on('message', onMessage)
  } catch {
    redisSubDisabled = true
    return () => undefined
  }

  return () => {
    void (async () => {
      try {
        client.off('message', onMessage)
        await client.unsubscribe(channel)
      } catch {
        // ignore
      }
    })()
  }
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
