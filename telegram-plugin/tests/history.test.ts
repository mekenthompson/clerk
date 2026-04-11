import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, statSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordInbound,
  recordOutbound,
  recordEdit,
  query,
  _resetForTests,
} from '../history.js'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'telegram-history-test-'))
})

afterEach(() => {
  _resetForTests()
  if (existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

describe('initHistory', () => {
  it('creates history.db with chmod 0600', () => {
    initHistory(stateDir, 30)
    const dbPath = join(stateDir, 'history.db')
    expect(existsSync(dbPath)).toBe(true)
    const st = statSync(dbPath)
    // Mask off the file-type bits — only the perm bits matter.
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('is idempotent — second call is a no-op', () => {
    initHistory(stateDir, 30)
    expect(() => initHistory(stateDir, 30)).not.toThrow()
  })
})

describe('recordInbound + query', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('round-trips a single message', () => {
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 5,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'hello',
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      chat_id: '-100',
      message_id: 5,
      role: 'user',
      user: 'alice',
      text: 'hello',
    })
  })

  it('returns oldest-first', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'first' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 2, user: 'a', user_id: '1', ts: 200, text: 'second' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 300, text: 'third' })
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => r.text)).toEqual(['first', 'second', 'third'])
  })

  it('respects the limit', () => {
    for (let i = 1; i <= 20; i++) {
      recordInbound({ chat_id: '-100', thread_id: null, message_id: i, user: 'a', user_id: '1', ts: 100 + i, text: `m${i}` })
    }
    const rows = query({ chat_id: '-100', limit: 5 })
    expect(rows).toHaveLength(5)
    // Newest 5, returned oldest-first
    expect(rows.map(r => r.text)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20'])
  })

  it('caps limit at 50', () => {
    for (let i = 1; i <= 100; i++) {
      recordInbound({ chat_id: '-100', thread_id: null, message_id: i, user: 'a', user_id: '1', ts: 100 + i, text: `m${i}` })
    }
    const rows = query({ chat_id: '-100', limit: 999 })
    expect(rows).toHaveLength(50)
  })

  it('paginates with before_message_id', () => {
    for (let i = 1; i <= 20; i++) {
      recordInbound({ chat_id: '-100', thread_id: null, message_id: i, user: 'a', user_id: '1', ts: 100 + i, text: `m${i}` })
    }
    const page1 = query({ chat_id: '-100', limit: 5 })
    expect(page1.map(r => r.text)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20'])
    const oldestId = page1[0]!.message_id
    const page2 = query({ chat_id: '-100', limit: 5, before_message_id: oldestId })
    expect(page2.map(r => r.text)).toEqual(['m11', 'm12', 'm13', 'm14', 'm15'])
  })

  it('filters by thread_id', () => {
    recordInbound({ chat_id: '-100', thread_id: 7, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'topicA' })
    recordInbound({ chat_id: '-100', thread_id: 8, message_id: 2, user: 'a', user_id: '1', ts: 100, text: 'topicB' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 100, text: 'root' })

    expect(query({ chat_id: '-100', thread_id: 7 }).map(r => r.text)).toEqual(['topicA'])
    expect(query({ chat_id: '-100', thread_id: 8 }).map(r => r.text)).toEqual(['topicB'])
    expect(query({ chat_id: '-100', thread_id: null }).map(r => r.text)).toEqual(['root'])
    // Omitted thread_id returns everything in the chat
    expect(query({ chat_id: '-100' })).toHaveLength(3)
  })

  it('isolates chats from each other', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'A' })
    recordInbound({ chat_id: '-200', thread_id: null, message_id: 1, user: 'b', user_id: '2', ts: 100, text: 'B' })
    expect(query({ chat_id: '-100' }).map(r => r.text)).toEqual(['A'])
    expect(query({ chat_id: '-200' }).map(r => r.text)).toEqual(['B'])
  })
})

describe('recordOutbound', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('records a single-chunk reply', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [42],
      texts: ['the answer'],
      ts: 500,
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      message_id: 42,
      role: 'assistant',
      text: 'the answer',
      group_id: 42,
    })
  })

  it('records each chunk of a multi-chunk reply with shared group_id', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [10, 11, 12],
      texts: ['part 1', 'part 2', 'part 3'],
      ts: 500,
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.message_id)).toEqual([10, 11, 12])
    expect(rows.map(r => r.group_id)).toEqual([10, 10, 10])
    expect(rows.map(r => r.text)).toEqual(['part 1', 'part 2', 'part 3'])
  })

  it('interleaves correctly with inbound when sorted by ts', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'q1' })
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [2], texts: ['a1'], ts: 200 })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 300, text: 'q2' })
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [4], texts: ['a2'], ts: 400 })
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => `${r.role}:${r.text}`)).toEqual([
      'user:q1',
      'assistant:a1',
      'user:q2',
      'assistant:a2',
    ])
  })
})

describe('recordEdit', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('updates an existing outbound row', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [42],
      texts: ['original'],
      ts: 500,
    })
    recordEdit({ chat_id: '-100', message_id: 42, text: 'edited' })
    const rows = query({ chat_id: '-100' })
    expect(rows[0]?.text).toBe('edited')
  })

  it('is a silent no-op for missing rows', () => {
    expect(() =>
      recordEdit({ chat_id: '-100', message_id: 999, text: 'oops' }),
    ).not.toThrow()
    expect(query({ chat_id: '-100' })).toHaveLength(0)
  })

  it('updates the row regardless of thread (Telegram message_ids are chat-unique)', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: 7,
      message_ids: [42],
      texts: ['original in thread 7'],
      ts: 500,
    })
    // Edit without knowing the thread — should still update the row.
    recordEdit({ chat_id: '-100', message_id: 42, text: 'edited' })
    const rows = query({ chat_id: '-100', thread_id: 7 })
    expect(rows[0]?.text).toBe('edited')
  })
})

describe('retention sweep', () => {
  it('deletes rows older than retentionDays on init', () => {
    initHistory(stateDir, 30)
    const oldTs = Math.floor(Date.now() / 1000) - 40 * 86400
    const recentTs = Math.floor(Date.now() / 1000) - 5 * 86400
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: oldTs, text: 'ancient' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 2, user: 'a', user_id: '1', ts: recentTs, text: 'recent' })
    // Re-init to fire the sweep
    _resetForTests()
    initHistory(stateDir, 30)
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => r.text)).toEqual(['recent'])
  })

  it('retentionDays=0 disables the sweep', () => {
    initHistory(stateDir, 0)
    const ancientTs = Math.floor(Date.now() / 1000) - 365 * 86400
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: ancientTs, text: 'ancient' })
    _resetForTests()
    initHistory(stateDir, 0)
    expect(query({ chat_id: '-100' })).toHaveLength(1)
  })
})
