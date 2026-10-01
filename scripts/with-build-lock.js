#!/usr/bin/env node
/**
 * Serialise heavy builds across concurrent agent sessions on this machine.
 *
 * Why this exists: two `next build`s running at once on one box fight for CPU and both crawl — a build that
 * normally finishes in ~3 minutes blew past a 10-minute timeout, twice, while another session was building.
 * The deploys already serialise (`/tmp/reloadsol-deploy.lock`, flock); local builds did not, so the
 * collision just looked like a hang.
 *
 * **This lock waits; it does not fail fast.** Being second in line is the expected case, so the loser of the
 * race queues and prints its position rather than erroring out.
 *
 * `flock` is deliberately not used: it is not present on macOS, which is where the agents build.
 *
 * Usage:
 *   node scripts/with-build-lock.js next build
 *   node scripts/with-build-lock.js --status
 *
 * Env:
 *   BUILD_LOCK              lock dir (default /tmp/reloadsol-build.lock)
 *   BUILD_LOCK_WAIT_SECS    how long to queue before giving up (default 1800)
 *   BUILD_LOCK_STALE_SECS   age at which a lock with no live owner is stolen (default 7200)
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const LOCK_DIR = process.env.BUILD_LOCK || '/tmp/reloadsol-build.lock'
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json')
const WAIT_SECS = Number(process.env.BUILD_LOCK_WAIT_SECS || 1800)
const STALE_SECS = Number(process.env.BUILD_LOCK_STALE_SECS || 7200)
const POLL_MS = 2000

const log = (msg) => process.stderr.write(`[build-lock] ${msg}\n`)

function readOwner() {
  try {
    return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'))
  } catch {
    return null
  }
}

function ownerIsGone(owner) {
  if (!owner) return false
  // A lock from another host cannot be probed; fall back to the age TTL alone.
  if (owner.host && owner.host !== os.hostname()) return false
  if (!owner.pid) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function describe(owner) {
  if (!owner) return 'unknown owner'
  const age = Math.round((Date.now() - (owner.startedAt || 0)) / 1000)
  return `pid ${owner.pid} on ${owner.host}, ${age}s ago: ${owner.command || '?'}`
}

/** Steal a lock whose owner is dead, or one older than the TTL. Returns true when it was stolen. */
function stealIfStale() {
  const owner = readOwner()
  const ageSecs = owner ? (Date.now() - (owner.startedAt || 0)) / 1000 : Infinity
  const dead = ownerIsGone(owner)
  const ancient = ageSecs > STALE_SECS
  if (!dead && !ancient) return false
  log(`stealing stale lock (${dead ? 'owner is gone' : `older than ${STALE_SECS}s`}) — ${describe(owner)}`)
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  return true
}

function acquire() {
  const deadline = Date.now() + WAIT_SECS * 1000
  let announced = false
  for (;;) {
    try {
      // mkdir is atomic: exactly one caller creates it.
      fs.mkdirSync(LOCK_DIR, { recursive: false })
      fs.writeFileSync(
        OWNER_FILE,
        JSON.stringify(
          {
            pid: process.pid,
            host: os.hostname(),
            startedAt: Date.now(),
            command: process.argv.slice(2).join(' '),
          },
          null,
          2,
        ),
      )
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (stealIfStale()) continue
      if (!announced) {
        log(`another build holds the lock — queueing (wait up to ${WAIT_SECS}s). ${describe(readOwner())}`)
        announced = true
      }
      if (Date.now() > deadline) {
        log(`gave up after ${WAIT_SECS}s waiting on ${LOCK_DIR}`)
        process.exit(75)
      }
      // Sleep without blocking the event loop for long stretches.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS)
    }
  }
}

function release() {
  const owner = readOwner()
  // Only the owner may release — never delete a lock someone else took.
  if (owner && owner.pid !== process.pid) return
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

if (process.argv[2] === '--status') {
  const owner = readOwner()
  if (!owner) {
    process.stdout.write(`[build-lock] free (${LOCK_DIR})\n`)
    process.exit(0)
  }
  process.stdout.write(`[build-lock] held — ${describe(owner)}\n`)
  process.exit(1)
}

const command = process.argv.slice(2)
if (command.length === 0) {
  log('nothing to run: pass a command, e.g. `node scripts/with-build-lock.js next build`')
  process.exit(2)
}

acquire()
log(`acquired (pid ${process.pid}) — running: ${command.join(' ')}`)

let released = false
const releaseOnce = () => {
  if (released) return
  released = true
  release()
}
process.on('exit', releaseOnce)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    releaseOnce()
    process.exit(130)
  })
}

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env })
child.on('error', (error) => {
  releaseOnce()
  log(`failed to start ${command[0]}: ${error.message}`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  releaseOnce()
  if (signal) {
    log(`command killed by ${signal}`)
    process.exit(1)
  }
  process.exit(code == null ? 1 : code)
})
