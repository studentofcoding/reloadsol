import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The lock exists because two concurrent `next build`s on one machine crawl and look like hangs. What
 * matters is that the loser **queues** (the whole point — being second is the expected case) and that a
 * lock whose owner died is recovered rather than wedging every later build.
 */
const SCRIPT = path.resolve(__dirname, 'with-build-lock.js')

let lockDir = ''
afterEach(() => {
  if (lockDir) fs.rmSync(lockDir, { recursive: true, force: true })
  lockDir = ''
})

function freshLock(): string {
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-lock-test-'))
  fs.rmSync(lockDir, { recursive: true, force: true }) // the runner creates it on acquire
  return lockDir
}

function run(command: string[], timeoutMs = 20_000) {
  const startedAt = Date.now()
  return new Promise<{ code: number | null; elapsed: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, ...command], {
        env: { ...process.env, BUILD_LOCK: lockDir, BUILD_LOCK_WAIT_SECS: '15' },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += String(d)))
      child.stderr.on('data', (d) => (stderr += String(d)))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, elapsed: Date.now() - startedAt, stdout, stderr })
      })
    },
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('with-build-lock', () => {
  it('runs the command and releases the lock afterwards', async () => {
    freshLock()
    const res = await run(['node', '-e', "process.stdout.write('ran')"])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('ran')
    expect(fs.existsSync(lockDir)).toBe(false)
  })

  it('QUEUES behind a held lock instead of failing', async () => {
    freshLock()
    const HOLD_MS = 1500
    const holder = run(['node', '-e', `setTimeout(() => {}, ${HOLD_MS})`])
    await sleep(300) // let the holder take the lock

    const second = await run(['node', '-e', "process.stdout.write('second ran')"])
    await holder

    expect(second.code).toBe(0)
    expect(second.stdout).toContain('second ran')
    // it waited for the holder rather than racing past it
    expect(second.elapsed).toBeGreaterThan(HOLD_MS - 400)
    expect(second.stderr).toContain('queueing')
    expect(fs.existsSync(lockDir)).toBe(false)
  })

  it('steals a lock whose owner is gone', async () => {
    freshLock()
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        pid: 999_999, // no such process
        host: os.hostname(),
        startedAt: Date.now(),
        command: 'next build',
      }),
    )

    const res = await run(['node', '-e', "process.stdout.write('stole it')"])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('stole it')
    expect(res.stderr).toContain('stealing stale lock')
  })

  it('reports status without running anything', async () => {
    freshLock()
    const free = await run(['--status'])
    expect(free.code).toBe(0)
    expect(free.stdout).toContain('free')
  })
})
