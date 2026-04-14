/**
 * Integration harness for the full progress-card pipeline:
 *   Claude Code session JSONL (on disk)
 *     -> SessionTail (fs.watch + poll rescan)
 *     -> ProgressCardDriver (reducer + cadence + heartbeat)
 *     -> mock Telegram Bot API (editMessageText capture)
 *
 * Unlike the existing unit tests (session-tail.test.ts,
 * progress-card-driver.test.ts) which stub either side, this harness
 * wires the REAL components together and drives them with byte-accurate
 * JSONL lines that mirror what Claude Code 2.1.x writes in production.
 *
 * The goal is to catch regressions in the wiring — bugs that are only
 * visible when the tail's cursor, the driver's coalesce timer, the
 * heartbeat interval, and the turn_end lane close all interact in real
 * time. That combination has already bitten us twice (PR #25 and this
 * PR), so an integration harness earns its keep.
 *
 * Why not fake timers: the session-tail polls the filesystem with
 * setInterval at rescanIntervalMs; mocking fs events AND timers
 * simultaneously is fragile. We use a short rescan (20ms) and real
 * wall-clock waits measured in tens of ms for tail-driven assertions.
 * The heartbeat path is covered separately with INJECTED timers on the
 * driver (the SessionTail is bypassed in that block) so heartbeat
 * timing stays deterministic.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSessionTail, getProjectsDirForCwd, type SessionEvent } from '../session-tail.js'
import { createProgressDriver } from '../progress-card-driver.js'
import { handleStreamReply } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, microtaskFlush } from './bot-api.harness.js'

// ─── Mock Telegram Bot API ────────────────────────────────────────────────

interface Edit { ts: number; chatId: string; html: string; done: boolean }

function mockBot() {
  const edits: Edit[] = []
  const now = () => Date.now()
  return {
    edits,
    emit: (args: { chatId: string; threadId?: string; html: string; done: boolean }) => {
      edits.push({ ts: now(), chatId: args.chatId, html: args.html, done: args.done })
    },
  }
}

// ─── Realistic JSONL line builders ────────────────────────────────────────
// Matches the shape produced by Claude Code 2.1.x (verified against
// /home/kenthompson/.clerk/agents/assistant/.claude/projects/.../*.jsonl).

const enqueueLine = (chatId: string, text = 'hello'): string =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<channel source="clerk-telegram" chat_id="${chatId}" message_id="1" user="u" ts="2026-04-14T00:00:00.000Z">\n${text}\n</channel>`,
  }) + '\n'

const toolUseLine = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }) + '\n'

const toolResultLine = (id: string, isError = false): string =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] },
  }) + '\n'

const turnEndLine = (): string =>
  JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1234 }) + '\n'

// ─── Harness fixture ──────────────────────────────────────────────────────

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tempDirs.length = 0
})

function mkProjectsDir() {
  const base = mkdtempSync(join(tmpdir(), 'pc-harness-'))
  tempDirs.push(base)
  const cwd = join(base, 'agent')
  const claudeHome = join(base, 'claude-home')
  const projectsDir = getProjectsDirForCwd(cwd, claudeHome)
  mkdirSync(projectsDir, { recursive: true })
  return { claudeHome, cwd, projectsDir }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── Tests ────────────────────────────────────────────────────────────────

describe('progress-card integration harness', () => {
  it('end-to-end: enqueue -> parallel tool_use -> tool_result -> turn_end', async () => {
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const bot = mockBot()

    const driver = createProgressDriver({
      emit: bot.emit,
      // Small coalesce so the test runs fast but still exercises the
      // cadence code (0 would bypass it entirely).
      coalesceMs: 20,
      minIntervalMs: 20,
      heartbeatMs: 0, // disable for this test — covered separately below
    })

    const parent = join(projectsDir, 'parent.jsonl')
    writeFileSync(parent, '')

    const tail = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 20,
      onEvent: (ev) => driver.ingest(ev, null),
    })

    try {
      await wait(80) // initial attach

      appendFileSync(parent, enqueueLine('c1', 'find the bug'))
      await wait(150)

      // Parallel tool_use calls (realistic: Claude batches Bash+Read).
      appendFileSync(parent, toolUseLine('t1', 'Bash', { command: 'ls' }))
      await wait(150)
      appendFileSync(parent, toolUseLine('t2', 'Read', { file_path: '/tmp/x' }))
      await wait(150)

      appendFileSync(parent, toolResultLine('t1'))
      appendFileSync(parent, toolResultLine('t2', /* error */ true))
      await wait(150)

      appendFileSync(parent, turnEndLine())
      await wait(200)

      // Assertion (a): every tool_use produced an observable render.
      // The card renders a checklist, so after both tool_use lines we
      // expect at least one edit whose HTML mentions both tools.
      const saw = (needle: string) => bot.edits.some((e) => e.html.includes(needle))
      expect(saw('Bash')).toBe(true)
      expect(saw('Read')).toBe(true)

      // Assertion (b): tool_result flips items to done/failed. The final
      // card carries the ✅ glyph the renderer uses for successful items.
      // Error handling (is_error=true → ❌) is asserted separately in
      // the driver unit tests, since the integration path's line-buffer
      // coalescing can race with the reducer's FIFO pairing fallback.
      const finalHtml = bot.edits[bot.edits.length - 1].html
      expect(finalHtml).toMatch(/✅/u)
      // is_error=true on one of the parallel tool_results must render as
      // a failed (❌) item in the final card. Historically this regressed
      // because the reducer's "close prior running item on new tool_use"
      // shortcut mis-paired the first tool_result onto the WRONG
      // parallel item — by the time the error-flagged tool_result
      // arrived, its matching tool_use was already force-done.
      expect(finalHtml).toMatch(/❌/u)

      // Assertion (d): turn_end produced exactly one done=true edit.
      const doneEdits = bot.edits.filter((e) => e.done)
      expect(doneEdits).toHaveLength(1)

      // Assertion (e): no edit AFTER turn_end's done=true.
      const lastIdx = bot.edits.findIndex((e) => e.done)
      expect(lastIdx).toBe(bot.edits.length - 1)

      // Peek confirms the chat state was dropped post turn_end.
      expect(driver.peek('c1')).toBeUndefined()
    } finally {
      tail.stop()
      driver.dispose?.()
    }
  }, 10_000)

  it('sub-agent JSONL mid-turn: parent events after re-attach are never lost', async () => {
    // Regression guard for the bug PR #25 tried to fix. The harness drives
    // the documented scenario end-to-end rather than just the session-tail
    // in isolation (where it already has a unit test).
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const bot = mockBot()

    const driver = createProgressDriver({
      emit: bot.emit,
      coalesceMs: 20,
      minIntervalMs: 20,
      heartbeatMs: 0,
    })

    const parent = join(projectsDir, 'parent.jsonl')
    const sub = join(projectsDir, 'sub.jsonl')
    writeFileSync(parent, '')

    const tail = startSessionTail({
      cwd, claudeHome, rescanIntervalMs: 20,
      onEvent: (ev) => driver.ingest(ev, null),
    })

    try {
      await wait(80)
      appendFileSync(parent, enqueueLine('c1', 'kick off sub-agent'))
      appendFileSync(parent, toolUseLine('t_task', 'Task', { description: 'go' }))
      await wait(120)

      // Mid-turn a sibling JSONL (simulating Claude Code flushing sub-agent
      // activity into the same projects dir) takes over as newest-mtime.
      const nowSec = Math.floor(Date.now() / 1000)
      writeFileSync(sub, '')
      utimesSync(sub, nowSec + 10, nowSec + 10)
      utimesSync(parent, nowSec + 5, nowSec + 5)
      await wait(80)

      appendFileSync(sub, toolUseLine('t_sub', 'Bash', { command: 'echo sub' }))
      utimesSync(sub, nowSec + 11, nowSec + 11)
      await wait(120)

      // Parent writes real events that MUST NOT be dropped when mtime
      // flips back. These are the events PR #25 claims to preserve.
      appendFileSync(parent, toolResultLine('t_task'))
      appendFileSync(parent, toolUseLine('t_final', 'Grep', { pattern: 'foo' }))
      appendFileSync(parent, toolResultLine('t_final'))
      appendFileSync(parent, turnEndLine())
      utimesSync(parent, nowSec + 20, nowSec + 20)
      await wait(300)

      // Assertion (f): parent-side subsequent events are NEVER lost. Even
      // if the sub-agent's events weren't surfaced to the driver (they
      // might be — depends on whether Task's tool_use id matches), the
      // Grep tool_use that came AFTER the mtime flip must be present,
      // and the turn_end must have closed the card.
      const sawGrep = bot.edits.some((e) => e.html.includes('Grep'))
      expect(sawGrep).toBe(true)
      const doneEdits = bot.edits.filter((e) => e.done)
      expect(doneEdits.length).toBe(1)
      expect(driver.peek('c1')).toBeUndefined()
    } finally {
      tail.stop()
      driver.dispose?.()
    }
  }, 10_000)

  it('sub-agent subdir layout (real Claude Code): parent JSONL stream never stalls', async () => {
    // NEW scenario discovered while building this harness: in real Claude
    // Code 2.1.x, sub-agent (Task) activity is written to
    //   <projectsDir>/<sessionId>/subagents/agent-*.jsonl
    // — a SUBDIRECTORY. The top-level scanner never sees those files.
    // During a long Task call the parent JSONL goes silent for minutes
    // while the sub-agent works. Without the heartbeat, the card appears
    // frozen to the user even though everything is healthy.
    //
    // This test exercises that exact layout: a parent JSONL that goes
    // silent mid-turn, with child files in a subdir that MUST be ignored.
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const bot = mockBot()

    const driver = createProgressDriver({
      emit: bot.emit,
      coalesceMs: 20,
      minIntervalMs: 20,
      heartbeatMs: 0,
    })

    const parent = join(projectsDir, 'session-A.jsonl')
    writeFileSync(parent, '')
    // Real Claude Code layout — the sub-agent files live HERE:
    const subdir = join(projectsDir, 'session-A', 'subagents')
    mkdirSync(subdir, { recursive: true })
    writeFileSync(join(subdir, 'agent-xyz.jsonl'), toolUseLine('ignored', 'X', {}))

    const tail = startSessionTail({
      cwd, claudeHome, rescanIntervalMs: 20,
      onEvent: (ev) => driver.ingest(ev, null),
    })

    try {
      await wait(80)
      appendFileSync(parent, enqueueLine('c1', 'task then reply'))
      appendFileSync(parent, toolUseLine('t_task', 'Task', { description: 'delegated work' }))
      await wait(120)

      // Simulate a 300ms sub-agent pause where the subdir file gets writes
      // but the parent is silent. (In production this is minutes.)
      appendFileSync(join(subdir, 'agent-xyz.jsonl'), toolUseLine('inner1', 'Read', { file_path: '/' }))
      await wait(300)

      // Parent resumes: Task completes and the assistant wraps up.
      appendFileSync(parent, toolResultLine('t_task'))
      appendFileSync(parent, turnEndLine())
      await wait(200)

      // The subdir tool_use MUST NOT have been surfaced (it's noise the
      // tailer shouldn't see). Only parent events should make it through.
      expect(bot.edits.some((e) => e.html.includes('Task'))).toBe(true)
      expect(bot.edits.some((e) => e.html.includes('"X"'))).toBe(false)
      const doneEdits = bot.edits.filter((e) => e.done)
      expect(doneEdits.length).toBe(1)
    } finally {
      tail.stop()
      driver.dispose?.()
    }
  }, 10_000)

  it('heartbeat emits while a turn is idle and stops cleanly on turn_end', () => {
    // Uses injected fake timers on the driver (no SessionTail in this
    // block — heartbeat logic lives in the driver).
    let now = 1000
    const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
    let nextRef = 0
    const emits: Edit[] = []

    const driver = createProgressDriver({
      emit: (a) => emits.push({ ts: now, chatId: a.chatId, html: a.html, done: a.done }),
      coalesceMs: 50,
      minIntervalMs: 50,
      heartbeatMs: 5000,
      now: () => now,
      setTimeout: (fn, ms) => { const ref = nextRef++; timers.push({ fireAt: now + ms, fn, ref }); return { ref } },
      clearTimeout: (h) => { const i = timers.findIndex((t) => t.ref === (h as { ref: number }).ref); if (i !== -1) timers.splice(i, 1) },
      setInterval: (fn, ms) => { const ref = nextRef++; timers.push({ fireAt: now + ms, fn, ref, repeat: ms }); return { ref } },
      clearInterval: (h) => { const i = timers.findIndex((t) => t.ref === (h as { ref: number }).ref); if (i !== -1) timers.splice(i, 1) },
    })

    const advance = (ms: number) => {
      const target = now + ms
      for (;;) {
        timers.sort((a, b) => a.fireAt - b.fireAt)
        const next = timers[0]
        if (!next || next.fireAt > target) break
        // Advance the fake clock to the fire time so the rendered
        // elapsed-time counter in the card header actually changes
        // between heartbeat ticks (otherwise the driver's coalesce
        // skips every heartbeat after the first).
        now = next.fireAt
        if (next.repeat != null) { next.fireAt += next.repeat; next.fn() }
        else { timers.shift(); next.fn() }
      }
      now = target
    }

    // Start turn + issue one tool_use, then go idle (simulates Task running).
    driver.startTurn({ chatId: 'c1', userText: 'do thing' })
    driver.ingest({ kind: 'tool_use', toolName: 'Task', toolUseId: 't_task', input: {} } as SessionEvent, 'c1')
    advance(100) // let coalesce flush

    const countBeforeIdle = emits.length
    // 30 seconds of no events — heartbeat MUST keep the card alive.
    advance(30_000)
    const heartbeats = emits.length - countBeforeIdle
    // Assertion (c): heartbeat fires at least once per 5s while turn open.
    // 30s / 5s = 6 opportunities; coalescing may collapse identical-HTML
    // ones, but with a ticking elapsed counter in the header each bucket
    // should emit at least once. Allow a floor of 3 for safety.
    expect(heartbeats).toBeGreaterThanOrEqual(3)

    // turn_end closes the lane — no more emits after that.
    const countBeforeEnd = emits.length
    driver.ingest({ kind: 'turn_end', durationMs: 30_100 } as SessionEvent, 'c1')
    expect(emits[emits.length - 1].done).toBe(true)

    // Long idle after turn_end: heartbeat must be dormant (lane closed).
    advance(60_000)
    const postEndEmits = emits.length - countBeforeEnd
    // Exactly 1 (the turn_end itself). No stragglers.
    expect(postEndEmits).toBe(1)

    driver.dispose?.()
  })
})

// ─── Multi-agent integration scenarios (design doc §5) ───────────────────
//
// These mirror §5.1–§5.7 of telegram-plugin/docs/multi-agent-card-design.md.
// Each scenario exercises the full pipeline (tail + correlation + render)
// with PROGRESS_CARD_MULTI_AGENT=1. §5.8 (rate-limit budget) is covered
// by the driver unit test instead — it needs a synthetic clock.
//
// The harness materializes a `<sessionId>/subagents/agent-<id>.jsonl`
// file alongside the parent JSONL so the new tail subdir watcher picks
// it up.

const subAgentUserLine = (promptText: string): string =>
  JSON.stringify({
    isSidechain: true,
    type: 'user',
    message: { role: 'user', content: promptText },
  }) + '\n'

const subAgentToolUseLine = (toolUseId: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    isSidechain: true,
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] },
  }) + '\n'

const subAgentToolResultLine = (toolUseId: string, isError = false): string =>
  JSON.stringify({
    isSidechain: true,
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] },
  }) + '\n'

const subAgentTurnEndLine = (): string =>
  JSON.stringify({ isSidechain: true, type: 'system', subtype: 'turn_duration', durationMs: 1 }) + '\n'

const parentAgentToolUseLine = (toolUseId: string, description: string, prompt: string, subagentType = 'researcher'): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: { subagent_type: subagentType, description, prompt },
        },
      ],
    },
  }) + '\n'

function mkSubagentJsonl(projectsDir: string, sessionStem: string, agentId: string): string {
  const dir = join(projectsDir, sessionStem, 'subagents')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `agent-${agentId}.jsonl`)
  writeFileSync(file, '')
  return file
}

describe('progress-card multi-agent harness', () => {
  const FLAG = 'PROGRESS_CARD_MULTI_AGENT'
  function withFlag<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env[FLAG]
    process.env[FLAG] = '1'
    return fn().finally(() => {
      if (prev != null) process.env[FLAG] = prev
      else delete process.env[FLAG]
    })
  }

  it('5.1 — 4 parallel sub-agents, all correlate', async () => {
    await withFlag(async () => {
      const { claudeHome, cwd, projectsDir } = mkProjectsDir()
      const bot = mockBot()
      const driver = createProgressDriver({
        emit: bot.emit,
        coalesceMs: 20,
        minIntervalMs: 20,
        heartbeatMs: 0,
      })
      const sessionStem = 'session-A'
      const parent = join(projectsDir, `${sessionStem}.jsonl`)
      writeFileSync(parent, '')

      const tail = startSessionTail({
        cwd, claudeHome, rescanIntervalMs: 20,
        onEvent: (ev) => driver.ingest(ev, null),
      })

      try {
        await wait(80)
        appendFileSync(parent, enqueueLine('c1', 'fan out 4 investigators'))
        for (let i = 1; i <= 4; i++) {
          appendFileSync(parent, parentAgentToolUseLine(`toolu_p${i}`, `task ${i}`, `PROMPT-${i}`))
        }
        await wait(150)

        // Pre-correlation: [Main] shows Agent lines but no [Sub-agents] block
        const preHtml = bot.edits[bot.edits.length - 1].html
        expect(preHtml).toContain('[Main')
        expect(preHtml).toContain('task 1')
        expect(preHtml).toContain('task 4')
        expect(preHtml).not.toContain('[Sub-agents')

        // Now create 4 sub-agent JSONLs in random-ish order with matching prompts
        const order = [3, 1, 4, 2]
        for (const i of order) {
          const file = mkSubagentJsonl(projectsDir, sessionStem, `aid${i}`)
          appendFileSync(file, subAgentUserLine(`PROMPT-${i}`))
        }
        await wait(200)

        const html = bot.edits[bot.edits.length - 1].html
        expect(html).toContain('[Sub-agents · 4 running]')
        for (let i = 1; i <= 4; i++) {
          expect(html).toContain(`task ${i}`)
        }

        // Each sub-agent emits a Read tool_use
        for (let i = 1; i <= 4; i++) {
          const file = join(projectsDir, sessionStem, 'subagents', `agent-aid${i}.jsonl`)
          appendFileSync(file, subAgentToolUseLine(`toolu_s${i}`, 'Read', { file_path: `/f${i}` }))
        }
        await wait(200)
        const midHtml = bot.edits[bot.edits.length - 1].html
        expect(midHtml).toContain('└ 🔧')

        // Parent tool_results for all 4
        for (let i = 1; i <= 4; i++) {
          appendFileSync(parent, toolResultLine(`toolu_p${i}`))
        }
        appendFileSync(parent, turnEndLine())
        await wait(250)

        const finalHtml = bot.edits[bot.edits.length - 1].html
        expect(finalHtml).toMatch(/\[Sub-agents · 4 done\]/)
        const doneEdits = bot.edits.filter((e) => e.done)
        expect(doneEdits.length).toBeGreaterThanOrEqual(1)
      } finally {
        tail.stop()
        driver.dispose?.()
      }
    })
  }, 15_000)

  it('5.2 — sub-agent finishes before parent tool_result (early ✅, then isError flips ❌)', async () => {
    await withFlag(async () => {
      const { claudeHome, cwd, projectsDir } = mkProjectsDir()
      const bot = mockBot()
      const driver = createProgressDriver({
        emit: bot.emit, coalesceMs: 20, minIntervalMs: 20, heartbeatMs: 0,
      })
      const stem = 'session-B'
      const parent = join(projectsDir, `${stem}.jsonl`)
      writeFileSync(parent, '')
      const tail = startSessionTail({
        cwd, claudeHome, rescanIntervalMs: 20,
        onEvent: (ev) => driver.ingest(ev, null),
      })
      try {
        await wait(80)
        appendFileSync(parent, enqueueLine('c1', 'one sub'))
        appendFileSync(parent, parentAgentToolUseLine('toolu_p1', 'investigate', 'PA'))
        const sub = mkSubagentJsonl(projectsDir, stem, 'aidX')
        appendFileSync(sub, subAgentUserLine('PA'))
        appendFileSync(sub, subAgentTurnEndLine())
        await wait(200)
        const earlyHtml = bot.edits[bot.edits.length - 1].html
        // Tentative ✅ for the sub-agent on early turn_end
        expect(earlyHtml).toMatch(/✅ investigate/)
        // Parent tool_result with isError=true overrides → ❌
        appendFileSync(parent, toolResultLine('toolu_p1', true))
        appendFileSync(parent, turnEndLine())
        await wait(250)
        const finalHtml = bot.edits[bot.edits.length - 1].html
        expect(finalHtml).toMatch(/❌ investigate/)
      } finally {
        tail.stop()
        driver.dispose?.()
      }
    })
  }, 15_000)

  it('5.3 — sub-agent JSONL appears AFTER parent tool_use (forward race)', async () => {
    await withFlag(async () => {
      const { claudeHome, cwd, projectsDir } = mkProjectsDir()
      const bot = mockBot()
      const driver = createProgressDriver({
        emit: bot.emit, coalesceMs: 20, minIntervalMs: 20, heartbeatMs: 0,
      })
      const stem = 'session-C'
      const parent = join(projectsDir, `${stem}.jsonl`)
      writeFileSync(parent, '')
      const tail = startSessionTail({
        cwd, claudeHome, rescanIntervalMs: 20,
        onEvent: (ev) => driver.ingest(ev, null),
      })
      try {
        await wait(80)
        appendFileSync(parent, enqueueLine('c1', 'race fwd'))
        appendFileSync(parent, parentAgentToolUseLine('toolu_p1', 'thing', 'PROMPT-X'))
        await wait(120)
        const before = bot.edits[bot.edits.length - 1].html
        expect(before).not.toContain('[Sub-agents')
        // Now create the JSONL
        const sub = mkSubagentJsonl(projectsDir, stem, 'aidA')
        appendFileSync(sub, subAgentUserLine('PROMPT-X'))
        await wait(200)
        const after = bot.edits[bot.edits.length - 1].html
        expect(after).toContain('[Sub-agents')
        expect(after).toContain('thing')
      } finally {
        tail.stop()
        driver.dispose?.()
      }
    })
  }, 15_000)

  it('5.4 — sub-agent JSONL appears BEFORE parent tool_use (reverse race adoption)', async () => {
    await withFlag(async () => {
      const { claudeHome, cwd, projectsDir } = mkProjectsDir()
      const bot = mockBot()
      const driver = createProgressDriver({
        emit: bot.emit, coalesceMs: 20, minIntervalMs: 20, heartbeatMs: 0,
      })
      const stem = 'session-D'
      const parent = join(projectsDir, `${stem}.jsonl`)
      writeFileSync(parent, '')
      const tail = startSessionTail({
        cwd, claudeHome, rescanIntervalMs: 20,
        onEvent: (ev) => driver.ingest(ev, null),
      })
      try {
        await wait(80)
        appendFileSync(parent, enqueueLine('c1', 'race rev'))
        // Create sub JSONL first with prompt; no parent tool_use yet
        const sub = mkSubagentJsonl(projectsDir, stem, 'aidR')
        appendFileSync(sub, subAgentUserLine('PROMPT-Y'))
        await wait(200)
        const orphanHtml = bot.edits[bot.edits.length - 1].html
        expect(orphanHtml).toContain('(uncorrelated)')
        // Now parent emits the Agent tool_use → adoption
        appendFileSync(parent, parentAgentToolUseLine('toolu_p1', 'reverse race target', 'PROMPT-Y'))
        await wait(200)
        const adoptedHtml = bot.edits[bot.edits.length - 1].html
        expect(adoptedHtml).toContain('reverse race target')
        expect(adoptedHtml).not.toContain('(uncorrelated)')
      } finally {
        tail.stop()
        driver.dispose?.()
      }
    })
  }, 15_000)

  it('5.5 — sub-sub-agent renders only as (spawned N) suffix on parent', async () => {
    await withFlag(async () => {
      const { claudeHome, cwd, projectsDir } = mkProjectsDir()
      const bot = mockBot()
      const driver = createProgressDriver({
        emit: bot.emit, coalesceMs: 20, minIntervalMs: 20, heartbeatMs: 0,
      })
      const stem = 'session-E'
      const parent = join(projectsDir, `${stem}.jsonl`)
      writeFileSync(parent, '')
      const tail = startSessionTail({
        cwd, claudeHome, rescanIntervalMs: 20,
        onEvent: (ev) => driver.ingest(ev, null),
      })
      try {
        await wait(80)
        appendFileSync(parent, enqueueLine('c1', 'nested'))
        appendFileSync(parent, parentAgentToolUseLine('toolu_p1', 'parent sub', 'PROMPT-N'))
        const subA = mkSubagentJsonl(projectsDir, stem, 'aidA')
        appendFileSync(subA, subAgentUserLine('PROMPT-N'))
        // Sub-agent A emits a nested Agent call (sub-sub-agent)
        appendFileSync(
          subA,
          subAgentToolUseLine('toolu_inner', 'Agent', { description: 'inner', prompt: 'PROMPT-INNER' }),
        )
        await wait(250)
        const html = bot.edits[bot.edits.length - 1].html
        expect(html).toContain('parent sub')
        expect(html).toContain('(spawned 1)')
        // Sub-sub-agent must NOT appear as its own row
        expect(html).not.toContain('inner')
      } finally {
        tail.stop()
        driver.dispose?.()
      }
    })
  }, 15_000)
})

// ─── Regression: progress card pinned to stale messageId across turns ────
//
// Two production bugs cause every progress-card update to land on the same
// Telegram messageId across many consecutive turns, so the card gets
// buried far up-chat above newer user messages and appears invisible:
//
//   (A) Orphan-turn routing: enqueue events occasionally land WITHOUT the
//       <channel chat_id="…"> wrapper. The driver's enqueue handler then
//       has no chatId and bails. Without a fallback the subsequent
//       turn_end can't route either, so done:true is never emitted.
//
//   (B) Stale stream persistence: when the driver's done:true never
//       emits, handleStreamReply never deletes the activeDraftStreams
//       entry and the next turn's startTurn reuses the existing stream
//       — editing the prior message rather than spawning a new one.
//
// This block wires the driver to the REAL handleStreamReply against a
// mock bot.api so we observe the same `editMessageText`/`sendMessage`
// pattern Telegram would receive in production.

describe('progress-card cross-turn lifecycle (regression for stale messageId)', () => {
  it('three consecutive turns each spawn a fresh messageId, even with one orphan enqueue', async () => {
    const bot = createMockBot(800)
    const activeDraftStreams = new Map<string, DraftStreamHandle>()
    const activeDraftParseModes = new Map<string, 'HTML' | 'MarkdownV2' | undefined>()

    const driver = createProgressDriver({
      // Wire the driver's emit through the same handleStreamReply path
      // server.ts uses, against the mock bot.
      emit: ({ chatId, threadId, html, done }) => {
        void handleStreamReply(
          {
            chat_id: chatId,
            text: html,
            done,
            message_thread_id: threadId,
            lane: 'progress',
            format: 'html',
          },
          { activeDraftStreams, activeDraftParseModes },
          {
            bot,
            markdownToHtml: (t) => t,
            escapeMarkdownV2: (t) => t,
            repairEscapedWhitespace: (t) => t,
            takeHandoffPrefix: () => '',
            assertAllowedChat: () => {},
            resolveThreadId: (_, explicit) => (explicit != null ? Number(explicit) : undefined),
            disableLinkPreview: true,
            defaultFormat: 'html',
            logStreamingEvent: () => {},
            endStatusReaction: () => {},
            historyEnabled: false,
            recordOutbound: () => {},
            writeError: () => {},
            // Fast throttle so the test runs quickly without burning
            // wall-clock waits.
            throttleMs: 10,
          },
        ).catch(() => { /* swallow — same fire-and-forget posture as server.ts */ })
      },
      coalesceMs: 5,
      minIntervalMs: 5,
      heartbeatMs: 0,
    })

    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

    // Helper that mirrors server.ts's onEvent fan-out for handleSessionEvent
    // → progressDriver.ingest. We don't need the full handleSessionEvent;
    // we only need to feed events into the driver. The closeProgressLane
    // path is what we want to exercise WITHOUT.
    const ingest = (ev: SessionEvent) => driver.ingest(ev, null)

    // ─── Turn 1 — wrapped enqueue (normal) ─────────────────────────────
    driver.startTurn({ chatId: 'c1', userText: 'first turn' })
    ingest({ kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: {} } as SessionEvent)
    await wait(40)
    ingest({ kind: 'tool_result', toolUseId: 't1', toolName: 'Bash' } as SessionEvent)
    ingest({ kind: 'turn_end', durationMs: 100 } as SessionEvent)
    await microtaskFlush(20)
    await wait(50)
    await microtaskFlush(20)

    // ─── Turn 2 — ORPHAN enqueue (no channel wrapper) ──────────────────
    // This simulates the production case where the parent JSONL writes a
    // queue-operation enqueue whose `content` lacks the <channel> XML.
    // The session-tail surfaces it as { kind:'enqueue', chatId:null, … }.
    // No startTurn call here either — startTurn comes from the inbound
    // user message gate, which the orphan path bypasses entirely (the
    // model self-enqueued, e.g. via auto-resume or an internal trigger).
    ingest({
      kind: 'enqueue',
      chatId: null,
      messageId: null,
      threadId: null,
      rawContent: 'orphan content with no channel wrapper',
    } as SessionEvent)
    ingest({ kind: 'tool_use', toolName: 'Read', toolUseId: 't2', input: {} } as SessionEvent)
    await wait(40)
    ingest({ kind: 'tool_result', toolUseId: 't2', toolName: 'Read' } as SessionEvent)
    ingest({ kind: 'turn_end', durationMs: 100 } as SessionEvent)
    await microtaskFlush(20)
    await wait(50)
    await microtaskFlush(20)

    // ─── Turn 3 — wrapped enqueue (normal) ─────────────────────────────
    driver.startTurn({ chatId: 'c1', userText: 'third turn' })
    ingest({ kind: 'tool_use', toolName: 'Grep', toolUseId: 't3', input: {} } as SessionEvent)
    await wait(40)
    ingest({ kind: 'tool_result', toolUseId: 't3', toolName: 'Grep' } as SessionEvent)
    ingest({ kind: 'turn_end', durationMs: 100 } as SessionEvent)
    await microtaskFlush(20)
    await wait(50)
    await microtaskFlush(20)

    driver.dispose?.()

    // ─── Assertions ────────────────────────────────────────────────────

    // (1) Each turn must have spawned its OWN sendMessage (a new
    //     Telegram message_id). With three turns we expect at least three
    //     distinct sendMessage calls — one per turn's first emit. Edits
    //     to a turn's own message via editMessageText are fine; what's
    //     not OK is the next turn editing the prior turn's message.
    const sentMessageIds = bot.api.sendMessage.mock.results
      .map((r) => (r.value as Promise<{ message_id: number }>))
    const resolvedIds = await Promise.all(sentMessageIds)
    const distinctSendIds = new Set(resolvedIds.map((r) => r.message_id))
    expect(distinctSendIds.size).toBeGreaterThanOrEqual(3)

    // (2) Every editMessageText call must target a message_id that was
    //     produced by a sendMessage WITHIN THE SAME TURN. We check this
    //     by walking the call log in order: track the "current" sent
    //     id (the most recent sendMessage), and assert every edit
    //     between sends targets that id. Cross-turn edits would target
    //     an id from a previous turn, which is the bug.
    const calls: Array<{ kind: 'send' | 'edit'; id: number }> = []
    for (const call of bot.api.sendMessage.mock.results) {
      const v = await (call.value as Promise<{ message_id: number }>)
      calls.push({ kind: 'send', id: v.message_id })
    }
    // Re-derive call ordering from invocation order. mock.invocationCallOrder
    // gives a global ordering across mocks, letting us interleave them.
    const sendOrder = bot.api.sendMessage.mock.invocationCallOrder
    const editOrder = bot.api.editMessageText.mock.invocationCallOrder
    const ordered: Array<{ kind: 'send' | 'edit'; id?: number; idx: number }> = []
    sendOrder.forEach((seq, i) => ordered.push({ kind: 'send', idx: seq, id: undefined }))
    editOrder.forEach((seq, i) =>
      ordered.push({ kind: 'edit', idx: seq, id: bot.api.editMessageText.mock.calls[i][1] as number }),
    )
    ordered.sort((a, b) => a.idx - b.idx)

    // Replay the chronologically-ordered stream of API calls.
    let currentSendId: number | null = null
    let sendIndex = 0
    for (const c of ordered) {
      if (c.kind === 'send') {
        const r = await (bot.api.sendMessage.mock.results[sendIndex++].value as Promise<{ message_id: number }>)
        currentSendId = r.message_id
      } else {
        // An edit must target the most recently sent id (same turn).
        expect(c.id).toBe(currentSendId)
      }
    }

    // (3) Every turn (including the orphan one in the middle) must have
    //     emitted a done:true to the bot — i.e. handleStreamReply with
    //     done=true ran for each turn, deleting the stream entry. We
    //     observe this indirectly: activeDraftStreams must be empty at
    //     the end, AND total sendMessage calls is one per turn (since
    //     done:true clean-up means each turn's first emit creates a
    //     fresh stream).
    expect(activeDraftStreams.size).toBe(0)
  }, 15_000)
})
