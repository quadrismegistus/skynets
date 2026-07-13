import { describe, expect, it } from 'vitest'
import { flattenThread } from './thread'

const TVP = 'app.bsky.feed.defs#threadViewPost'

/** A synthetic ThreadViewPost node. */
function node(uri: string, replies: unknown[] = [], parent?: unknown) {
  return {
    $type: TVP,
    post: { uri, cid: `cid-${uri}`, author: { handle: 'a' }, record: { $type: 'app.bsky.feed.post', text: 't' } },
    replies,
    parent,
  }
}

describe('flattenThread', () => {
  it('flattens a nested thread depth-first, skipping non-post nodes', () => {
    const tree = node('at://root', [
      node('at://r1', [node('at://r1a')]),
      node('at://r2'),
      { $type: 'app.bsky.feed.defs#notFoundPost', uri: 'at://gone', notFound: true },
      { $type: 'app.bsky.feed.defs#blockedPost', uri: 'at://blocked', blocked: true },
    ])
    const uris = flattenThread(tree).map((i) => i.post.uri)
    expect(uris).toEqual(['at://root', 'at://r1', 'at://r1a', 'at://r2'])
  })

  it('returns empty for a NotFound/Blocked root', () => {
    expect(flattenThread({ $type: 'app.bsky.feed.defs#notFoundPost' })).toEqual([])
    expect(flattenThread(undefined)).toEqual([])
  })

  it('climbs the ancestor chain of the anchor post', () => {
    const grandparent = node('at://gp')
    const parent = node('at://p', [], grandparent)
    const anchor = node('at://anchor', [node('at://reply')], parent)
    const uris = flattenThread(anchor).map((i) => i.post.uri)
    expect(uris).toEqual(['at://anchor', 'at://reply', 'at://p', 'at://gp'])
  })

  it('stops climbing at a NotFound parent', () => {
    const parent = node('at://p', [], { $type: 'app.bsky.feed.defs#notFoundPost' })
    const anchor = node('at://anchor', [], parent)
    const uris = flattenThread(anchor).map((i) => i.post.uri)
    expect(uris).toEqual(['at://anchor', 'at://p'])
  })
})
