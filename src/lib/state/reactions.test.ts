import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clear } from 'idb-keyval'
import { Reactions, tallyByAuthor, type Reaction } from './reactions.svelte'

const row = (did: string, reaction: 'up' | 'down'): Reaction => ({
  uri: `at://${did}/${reaction}/${Math.random()}`,
  did,
  reaction,
  t: 0,
})

beforeEach(async () => {
  await clear() // idb-keyval's default store is shared across instances
})

describe('reactions store (#66 private thumbs)', () => {
  it('records a reaction with the author did and returns the kind', async () => {
    const r = new Reactions()
    await r.load('did:plc:me')
    expect(await r.react('at://p/1', 'did:plc:alice', 'up')).toBe('up')
    expect(r.reactionOf('at://p/1')).toBe('up')
    // The did rides along on the row so the by-poster tally needs no post join.
    expect([...r.byUri.values()][0].did).toBe('did:plc:alice')
  })

  it('toggles off when the same reaction is pressed again', async () => {
    const r = new Reactions()
    await r.load('did:plc:me')
    await r.react('at://p/1', 'did:plc:alice', 'down')
    expect(await r.react('at://p/1', 'did:plc:alice', 'down')).toBeUndefined()
    expect(r.reactionOf('at://p/1')).toBeUndefined()
  })

  it('flips when the opposite reaction is pressed', async () => {
    const r = new Reactions()
    await r.load('did:plc:me')
    await r.react('at://p/1', 'did:plc:alice', 'up')
    expect(await r.react('at://p/1', 'did:plc:alice', 'down')).toBe('down')
    expect(r.reactionOf('at://p/1')).toBe('down')
  })

  it('persists across reloads (does not leave the archive — but survives it)', async () => {
    const a = new Reactions()
    await a.load('did:plc:me')
    await a.react('at://p/1', 'did:plc:alice', 'up')

    const b = new Reactions()
    await b.load('did:plc:me')
    expect(b.reactionOf('at://p/1')).toBe('up')
  })

  it('keys per-user so one account cannot see another account reactions', async () => {
    const mine = new Reactions()
    await mine.load('did:plc:me')
    await mine.react('at://p/1', 'did:plc:alice', 'down')

    const theirs = new Reactions()
    await theirs.load('did:plc:other')
    expect(theirs.reactionOf('at://p/1')).toBeUndefined()
  })

  it('is a no-op before a user is loaded (nothing to key persistence on)', async () => {
    const r = new Reactions()
    expect(await r.react('at://p/1', 'did:plc:alice', 'up')).toBeUndefined()
    expect(r.reactionOf('at://p/1')).toBeUndefined()
  })

  it('reset drops in-memory state but leaves persistence intact', async () => {
    const r = new Reactions()
    await r.load('did:plc:me')
    await r.react('at://p/1', 'did:plc:alice', 'up')
    r.reset()
    expect(r.reactionOf('at://p/1')).toBeUndefined()

    const reopened = new Reactions()
    await reopened.load('did:plc:me')
    expect(reopened.reactionOf('at://p/1')).toBe('up')
  })

  it('purge deletes the on-disk key too — a wiped device stays wiped after reload', async () => {
    const r = new Reactions()
    await r.load('did:plc:me')
    await r.react('at://p/1', 'did:plc:alice', 'up')
    await r.purge()
    expect(r.reactionOf('at://p/1')).toBeUndefined()

    // Unlike reset(), a fresh load must NOT see the reaction resurrected.
    const reopened = new Reactions()
    await reopened.load('did:plc:me')
    expect(reopened.reactionOf('at://p/1')).toBeUndefined()
  })
})

describe('tallyByAuthor (#69 aggregation view)', () => {
  it('groups by author and computes up/down/net/total', () => {
    const out = tallyByAuthor([
      row('did:a', 'down'),
      row('did:a', 'down'),
      row('did:a', 'up'),
      row('did:b', 'up'),
    ])
    const a = out.find((t) => t.did === 'did:a')!
    expect(a).toMatchObject({ up: 1, down: 2, net: -1, total: 3 })
    const b = out.find((t) => t.did === 'did:b')!
    expect(b).toMatchObject({ up: 1, down: 0, net: 1, total: 1 })
  })

  it('ranks most-negative net first (top of list = unfollow candidate)', () => {
    const out = tallyByAuthor([
      row('did:liked', 'up'),
      row('did:liked', 'up'),
      row('did:hated', 'down'),
      row('did:hated', 'down'),
      row('did:hated', 'down'),
      row('did:mixed', 'up'),
      row('did:mixed', 'down'),
    ])
    expect(out.map((t) => t.did)).toEqual(['did:hated', 'did:mixed', 'did:liked'])
  })

  it('breaks net ties by higher volume — a -3 from six outranks a -3 from three', () => {
    const out = tallyByAuthor([
      // did:quiet: 0 up, 3 down → net -3, total 3
      row('did:quiet', 'down'),
      row('did:quiet', 'down'),
      row('did:quiet', 'down'),
      // did:loud: 3 up, 6 down → net -3, total 9
      ...Array.from({ length: 3 }, () => row('did:loud', 'up')),
      ...Array.from({ length: 6 }, () => row('did:loud', 'down')),
    ])
    expect(out.map((t) => t.did)).toEqual(['did:loud', 'did:quiet'])
  })

  it('is empty for no reactions', () => {
    expect(tallyByAuthor([])).toEqual([])
  })
})
