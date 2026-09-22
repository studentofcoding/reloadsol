import { after } from 'next/server'

/**
 * Run work after the Next.js response is finished so native chart encode
 * cannot take down the in-flight HTTP handler. Outside a request (cron,
 * scripts, tests) `after()` throws and the work is deferred with setImmediate.
 * Rejections are logged and do not propagate to the caller.
 */
export function scheduleOffRequestPath(
  logLabel: string,
  work: () => Promise<void>,
): void {
  const task = (): Promise<void> =>
    work().catch((err) => {
      console.error(`${logLabel}:`, err)
    })

  try {
    after(task)
  } catch {
    setImmediate(() => {
      void task()
    })
  }
}
