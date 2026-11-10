// The sheet is the interface and the pane shows the lower levels. Nothing here adds to the system prompt or starts a
// turn on its own: `openarc sync --watch` does the work outside the conversation, and /openarc-fix only fills the prompt
// box with the items that need attention.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SyncStatus } from '../types'

const PANE = 'openarc'
const LOCAL_BIN = 'node_modules/.bin/openarc'
const LOG_LINES = 200
const status = atom({ plugin: 'openarc', key: 'status' } as const, null as SyncStatus | null, { shape: 'status-1' })
const log = atom({ plugin: 'openarc', key: 'log' } as const, [] as string[], { shape: 'log-1' })
const seen = atom({ plugin: 'openarc', key: 'seen' } as const, '' as string, { shape: 'seen-1' }) // the status file's last text

const exists = async ($: any, path: string) => {
  try {
    await $.fs.read(path)
    return true
  } catch {
    return false
  }
}
const line = (s: SyncStatus | null) =>
  !s
    ? 'openarc: not synced yet'
    : [
        `openarc: ${s.regions} regions`,
        s.attention.length ? `${s.attention.length} need attention` : '',
        s.suggestions ? `${s.suggestions} suggestions` : '',
        `hosted tokens today ${s.hostedTokensToday}`,
      ]
        .filter(Boolean)
        .join(' · ')

const show = async ($: any, s: SyncStatus) => {
  await update($, status, () => s)
  $.ui.status(line(s))
}

/** Run openarc, sending status lines to the pane's state and everything else to its log; resolves its exit code. */
async function pump($: any, args: string[]): Promise<number> {
  const bin = (await exists($, LOCAL_BIN)) ? LOCAL_BIN : 'openarc'
  try {
    return await stream($, [bin, ...args])
  } catch {
    await update($, log, list => [...list, 'openarc is not installed here: run npm i -D open-arc'])
    return 127
  }
}
async function stream($: any, argv: string[]): Promise<number> {
  const take = async (l: string) => {
    if (!l) return
    if (l.startsWith('{')) {
      try {
        return void (await show($, JSON.parse(l) as SyncStatus))
      } catch {
        // not a status line: it goes to the log like any other
      }
    }
    await update($, log, list => [...list, l].slice(-LOG_LINES))
  }
  // Text arrives as it was written, not by lines: keep the unfinished tail until its newline comes.
  let rest = ''
  const it = $.process.spawn({ argv })[Symbol.asyncIterator]()
  for (;;) {
    const r = await it.next()
    if (r.done) {
      await take(rest)
      return r.value?.code ?? 1
    }
    const parts = (rest + String(r.value.text ?? '')).split('\n')
    rest = parts.pop()!
    for (const l of parts) await take(l)
  }
}

/** Another session's watcher may own this project: its status file is the shared truth, read every few seconds. */
const STATUS_FILE = '.openarc/sync-status.json'
const POLL_MS = 3000
let polling = false
const poll = ($: any) => {
  if (polling) return
  polling = true
  $.clock.every(POLL_MS, () => refresh($))
}
async function refresh($: any) {
  try {
    const text = await $.fs.read(STATUS_FILE)
    if (text !== (await read($, seen))) {
      await update($, seen, () => text)
      await show($, JSON.parse(text) as SyncStatus)
    }
  } catch {
    // no sync yet, or a write in progress: the next tick reads it
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'openarc', description: 'Show the OpenArc pane' })
    await $.command.register({ name: 'openarc-adopt', description: 'Generate specs for this repo, then keep them in sync' })
    await $.command.register({ name: 'openarc-fix', description: 'Draft a prompt with only what OpenArc could not settle' })
    if (await exists($, 'openarc.config.json')) {
      await refresh($) // the last sync's status, until a pass reports
      poll($)
      void $.ui.open({ id: PANE, title: 'OpenArc' })
      void pump($, ['sync', '--watch', '--json'])
    }
    return started
  })

  on('command.run', { command: 'openarc' }, async $ => {
    await $.ui.open({ id: PANE, title: 'OpenArc' })
    return { text: line(await read($, status)) }
  })

  on('command.run', { command: 'openarc-adopt' }, async $ => {
    await $.ui.open({ id: PANE, title: 'OpenArc' })
    void (async () => {
      const code = await pump($, ['adopt', '--json'])
      if (code !== 0) return void (await update($, log, list => [...list, `adopt failed (exit ${code}): see above; the watcher was not started`]))
      poll($)
      await pump($, ['sync', '--watch', '--json'])
    })()
    return { text: 'Adopting: bodies stay as they are. Edit openarc.spec.md when it appears.' }
  })

  on('command.run', { command: 'openarc-fix' }, async $ => {
    const s = await read($, status)
    if (!s?.attention.length) return { text: 'Nothing needs attention.' }
    const items = s.attention.slice(0, 10).map(a => `- ${a.id}: ${a.what}`).join('\n')
    // Into the prompt box, not sent: spending this session's tokens stays the person's keypress.
    await $.prompt.fill({ text: `Use the openarc-sheet skill. These need attention; look only at these regions:\n${items}` })
    return { text: 'Press Enter to send it to Claude.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, status)
    const lines = await read($, log)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6 - (s?.attention.length ?? 0))
    return (
      <Box flexDirection="column">
        <Text>{line(s)}</Text>
        {s && s.localTokensToday > 0 && <Text dimColor>local tokens today {s.localTokensToday}</Text>}
        {(s?.attention ?? []).map(a => (
          <Text color="warning">{a.id}: {a.what}</Text>
        ))}
        {lines.slice(-room).map(l => (
          <Text dimColor>{l}</Text>
        ))}
      </Box>
    )
  })
}
