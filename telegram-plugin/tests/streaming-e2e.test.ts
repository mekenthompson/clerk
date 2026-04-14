/**
 * End-to-end smoke tests for the full streaming pipeline.
 *
 * These wire the PTY partial handler, the stream_reply handler, and the
 * activeDraftStreams map together against the mock bot — simulating the
 * sequence server.ts sees in production:
 *
 *   session enqueue → PTY partial → stream_reply (chunk 1..N)
 *                                 → stream_reply done=true → turn_end
 *
 * Goal: lock in the full-pipeline call shapes so that a regression
 * anywhere in the stack (extractor wiring, handoff, suppressPty,
 * done-cleanup) fails a test instead of going silent in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPtyPartialHandler,
  type PtyHandlerState,
} from '../pty-partial-handler.js'
import { handleStreamReply, type StreamReplyState } from '../stream-reply-handler.js'
import type { DraftStreamHandle } from '../draft-stream.js'
import { createMockBot, installBotResetHook, microtaskFlush } from './bot-api.harness.js'

interface Fixture {
  bot: ReturnType<typeof createMockBot>
  map: Map<string, DraftStreamHandle>
  suppress: Set<string>
  lastPreview: Map<string, string>
  ptyState: PtyHandlerState
  srState: StreamReplyState
  pty: ReturnType<typeof createPtyPartialHandler>
  callStreamReply: (args: {
    chat_id: string
    text: string
    done?: boolean
    lane?: string
  }) => Promise<{ messageId: number | null; status: string }>
  /**
   * Fire-and-forget variant: starts handleStreamReply but doesn't await it.
   * Tests drive timers + microtaskFlush to make progress, then
   * optionally await the returned promise when they expect it to settle.
   */
  fireStreamReply: (args: {
    chat_id: string
    text: string
    done?: boolean
    lane?: string
  }) => Promise<{ messageId: number | null; status: string }>
  turnEnd: () => void
}

function setup(opts: { progressCardActive?: boolean } = {}): Fixture {
  const bot = createMockBot()
  const map = new Map<string, DraftStreamHandle>()
  const suppress = new Set<string>()
  const lastPreview = new Map<string, string>()

  const ptyState: PtyHandlerState = {
    currentSessionChatId: null,
    currentSessionThreadId: undefined,
    pendingPtyPartial: null,
    activeDraftStreams: map,
    suppressPtyPreview: suppress,
    lastPtyPreviewByChat: lastPreview,
  }
  // Only wire suppressPtyPreview into stream_reply state when checklist
  // mode is active. Legacy (PTY-tail) tests assert that a PTY partial
  // arriving after stream_reply started feeds into the same stream via
  // 'update-existing'; in checklist mode stream_reply claims the
  // suppress slot first so the PTY handler would short-circuit to
  // 'suppressed' instead. Keep the two worlds separate.
  const srState: StreamReplyState = opts.progressCardActive === true
    ? { activeDraftStreams: map, suppressPtyPreview: suppress }
    : { activeDraftStreams: map }

  const pty = createPtyPartialHandler(ptyState, {
    bot,
    renderText: (t) => `<i>${t}</i>`, // PTY preview: italic
  })

  const callStreamReply = (args: {
    chat_id: string
    text: string
    done?: boolean
    lane?: string
  }) =>
    handleStreamReply(args, srState, {
      bot,
      markdownToHtml: (t) => `<b>${t}</b>`, // stream_reply: bold
      escapeMarkdownV2: (t) => t,
      repairEscapedWhitespace: (t) => t,
      takeHandoffPrefix: () => '',
      assertAllowedChat: () => {},
      resolveThreadId: () => undefined,
      disableLinkPreview: true,
      defaultFormat: 'html',
      logStreamingEvent: () => {},
      endStatusReaction: () => {},
      historyEnabled: false,
      recordOutbound: () => {},
      writeError: () => {},
      throttleMs: 600,
      progressCardActive: opts.progressCardActive === true,
    })

  const turnEnd = () => {
    pty.onTurnEnd()
  }

  return {
    bot, map, suppress, lastPreview, ptyState, srState, pty,
    callStreamReply,
    fireStreamReply: callStreamReply,
    turnEnd,
  }
}

describe('streaming e2e smoke', () => {
  const holder = { current: setup() }
  installBotResetHook(holder.current.bot)

  beforeEach(() => {
    vi.useFakeTimers()
    holder.current = setup()
  })
  afterEach(() => vi.useRealTimers())

  it('enqueue → PTY partial → stream_reply → done produces one message with one edit', async () => {
    const f = holder.current

    f.pty.onSessionEnqueue('42')
    f.pty.onPartial('drafting…')
    await microtaskFlush()

    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.sendMessage.mock.calls[0][0]).toBe('42')
    expect(f.bot.api.sendMessage.mock.calls[0][1]).toBe('<i>drafting…</i>')

    // Model calls stream_reply with canonical text. Throttle window not
    // open yet, so drive timers before awaiting.
    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const p1 = f.fireStreamReply({ chat_id: '42', text: 'final answer' })
    await microtaskFlush()
    const r1 = await p1

    expect(r1.status).toBe('updated')
    expect(r1.messageId).toBe(500)
    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(f.bot.api.editMessageText.mock.calls[0][2]).toBe('<b>final answer</b>')

    // done=true with same text → stream.finalize() resolves immediately
    // (pendingText is null since the edit already landed).
    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const r2 = await f.fireStreamReply({ chat_id: '42', text: 'final answer', done: true })

    expect(r2.status).toBe('finalized')
    expect(f.map.has('42:_')).toBe(false)
    expect(f.bot.api.editMessageText).toHaveBeenCalledTimes(1)

    f.turnEnd()
    expect(f.ptyState.currentSessionChatId).toBeNull()
    expect(f.lastPreview.size).toBe(0)
  })

  it('multiple stream_reply chunks during one turn produce a single message', async () => {
    const f = holder.current
    f.pty.onSessionEnqueue('1')

    // First chunk fires immediately (throttle window open at start).
    const p1 = f.fireStreamReply({ chat_id: '1', text: 'reading file…' })
    await microtaskFlush()
    await p1

    // Subsequent chunks — advance timers between each to open throttle.
    for (const t of ['analyzing…', 'writing response…']) {
      vi.advanceTimersByTime(1000)
      await microtaskFlush()
      const p = f.fireStreamReply({ chat_id: '1', text: t })
      await microtaskFlush()
      await p
    }
    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const pdone = f.fireStreamReply({ chat_id: '1', text: 'done!', done: true })
    await microtaskFlush()
    await pdone

    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    const editIds = f.bot.api.editMessageText.mock.calls.map(c => c[1])
    expect(new Set(editIds).size).toBe(1)
    expect(f.map.has('1:_')).toBe(false)
  })

  it('PTY partial that arrives BEFORE enqueue is buffered then replayed', async () => {
    const f = holder.current

    f.pty.onPartial('early text')
    await microtaskFlush()
    expect(f.bot.api.sendMessage).not.toHaveBeenCalled()
    expect(f.ptyState.pendingPtyPartial).toEqual({ text: 'early text' })

    f.pty.onSessionEnqueue('1')
    await microtaskFlush()

    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.sendMessage.mock.calls[0][1]).toBe('<i>early text</i>')
    expect(f.ptyState.pendingPtyPartial).toBeNull()
  })

  it('PTY partial after stream_reply started feeds into the same stream', async () => {
    const f = holder.current
    f.pty.onSessionEnqueue('1')

    const p1 = f.fireStreamReply({ chat_id: '1', text: 'stream_reply first' })
    await microtaskFlush()
    await p1
    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const action = f.pty.onPartial('stream_reply first — more')
    await microtaskFlush()

    expect(action).toBe('update-existing')
    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(f.map.size).toBe(1)
  })

  it('two chats run streams concurrently without interfering', async () => {
    const f = holder.current

    f.pty.onSessionEnqueue('A')
    const pA = f.fireStreamReply({ chat_id: 'A', text: 'for A' })
    await microtaskFlush()
    await pA

    f.ptyState.currentSessionChatId = 'B'
    const pB = f.fireStreamReply({ chat_id: 'B', text: 'for B' })
    await microtaskFlush()
    await pB

    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(2)
    const chats = f.bot.api.sendMessage.mock.calls.map(c => c[0]).sort()
    expect(chats).toEqual(['A', 'B'])

    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const pAdone = f.fireStreamReply({ chat_id: 'A', text: 'for A (done)', done: true })
    await microtaskFlush()
    await pAdone

    expect(f.map.has('A:_')).toBe(false)
    expect(f.map.has('B:_')).toBe(true)
  })

  it('checklist mode: default-lane done=false is suppressed (no Telegram traffic)', async () => {
    // Reproduces the user-visible bug: in checklist mode (production
    // default via CLERK_TG_STREAM_MODE=checklist), mid-turn stream_reply
    // calls on the default lane must be silently suppressed so the
    // progress card owns the mid-turn surface without a duplicate
    // narrative message. Only the final done=true call posts.
    holder.current = setup({ progressCardActive: true })
    const f = holder.current

    const r1 = await f.fireStreamReply({ chat_id: '42', text: 'looking into this…' })
    await microtaskFlush()

    expect(r1.status).toBe('updated')
    expect(r1.messageId).toBeNull()
    expect(f.bot.api.sendMessage).not.toHaveBeenCalled()
    expect(f.bot.api.editMessageText).not.toHaveBeenCalled()
    // PTY preview slot is claimed even when suppressed — stops a late
    // PTY partial from leaking a raw-TUI draft.
    expect(f.suppress.has('42:_')).toBe(true)
  })

  it('checklist mode: named lane (thinking) is honored end-to-end', async () => {
    // Escape hatch for agents that DO want a live mid-turn text surface
    // in checklist mode: call with lane:"thinking" (or any named lane).
    // Named-lane calls bypass the default-lane suppression.
    holder.current = setup({ progressCardActive: true })
    const f = holder.current

    const p1 = f.fireStreamReply({ chat_id: '42', text: 'reading config…', lane: 'thinking' })
    await microtaskFlush()
    const r1 = await p1

    expect(r1.status).toBe('updated')
    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.sendMessage.mock.calls[0][0]).toBe('42')
    expect(f.bot.api.sendMessage.mock.calls[0][1]).toBe('<b>reading config…</b>')

    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const p2 = f.fireStreamReply({ chat_id: '42', text: 'now grepping…', lane: 'thinking' })
    await microtaskFlush()
    await p2

    // Second chunk edits the same message — one send, one edit.
    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(f.map.has('42:_:thinking')).toBe(true)
  })

  it('checklist mode: final done=true on default lane posts the answer', async () => {
    // After N suppressed intermediates, the terminal done=true still
    // needs to actually post — that's the answer message. This is the
    // single most important invariant in checklist mode and the thing
    // that would silently break under a regression.
    holder.current = setup({ progressCardActive: true })
    const f = holder.current

    // Intermediate suppressed call.
    await f.fireStreamReply({ chat_id: '1', text: 'working…' })
    await microtaskFlush()
    expect(f.bot.api.sendMessage).not.toHaveBeenCalled()

    // Terminal call — must send.
    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const pdone = f.fireStreamReply({ chat_id: '1', text: 'THE ANSWER', done: true })
    await microtaskFlush()
    await pdone

    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(f.bot.api.sendMessage.mock.calls[0][1]).toBe('<b>THE ANSWER</b>')
    expect(f.map.has('1:_')).toBe(false)
  })

  it('checklist mode: named lane + final default-lane answer coexist as two messages', async () => {
    // Full production shape in checklist mode when an agent opts in to a
    // live "thinking" lane: the thinking lane streams edits to message A,
    // the final done=true default-lane call posts message B (the
    // answer). Two distinct Telegram messages for one turn, each with
    // the right text, no cross-talk.
    holder.current = setup({ progressCardActive: true })
    const f = holder.current

    const pThink = f.fireStreamReply({ chat_id: '1', text: 'thinking step 1…', lane: 'thinking' })
    await microtaskFlush()
    await pThink

    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const pThink2 = f.fireStreamReply({ chat_id: '1', text: 'thinking step 2…', lane: 'thinking' })
    await microtaskFlush()
    await pThink2

    // Suppressed intermediate on default lane — no extra send.
    await f.fireStreamReply({ chat_id: '1', text: 'almost done' })
    await microtaskFlush()

    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const pAnswer = f.fireStreamReply({ chat_id: '1', text: 'Here is the answer.', done: true })
    await microtaskFlush()
    await pAnswer

    // Two distinct Telegram messages sent: one for 'thinking', one for
    // the final answer. The intermediate default-lane call did NOT send.
    expect(f.bot.api.sendMessage).toHaveBeenCalledTimes(2)
    const sendTexts = f.bot.api.sendMessage.mock.calls.map(c => c[1])
    expect(sendTexts).toContain('<b>thinking step 1…</b>')
    expect(sendTexts).toContain('<b>Here is the answer.</b>')
    // Thinking lane got an edit for step 2.
    expect(f.bot.api.editMessageText).toHaveBeenCalled()
    const editTexts = f.bot.api.editMessageText.mock.calls.map(c => c[2])
    expect(editTexts).toContain('<b>thinking step 2…</b>')
  })

  it('done=true with changed text flushes the final edit before clearing', async () => {
    // Canary: user sees the "drafting" preview but never the final answer.
    const f = holder.current
    f.pty.onSessionEnqueue('1')

    const p1 = f.fireStreamReply({ chat_id: '1', text: 'drafting' })
    await microtaskFlush()
    await p1

    vi.advanceTimersByTime(1000)
    await microtaskFlush()
    const pdone = f.fireStreamReply({ chat_id: '1', text: 'THE ACTUAL ANSWER', done: true })
    await microtaskFlush()
    await pdone

    const lastEdit = f.bot.api.editMessageText.mock.calls.at(-1)
    expect(lastEdit?.[2]).toBe('<b>THE ACTUAL ANSWER</b>')
    expect(f.map.has('1:_')).toBe(false)
  })
})
