import type { FeedItem } from './timeline'

/** Demo/fixture mode: `?demo=1` renders the graph with local fake posts, no login. */
export function isDemo(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo')
}

const AUTHORS = [
  ['alice.bsky.social', 'Alice Nguyen'],
  ['bveselka.bsky.social', 'Bo Veselka'],
  ['cmount.bsky.social', 'Cass Mount'],
  ['dpark.bsky.social', 'Dana Park'],
  ['erao.bsky.social', 'El Rao'],
  ['fsato.bsky.social', 'Fen Sato'],
]

const BASE = Date.parse('2026-07-12T15:00:00Z')

interface Spec {
  id: string
  ai: number
  text: string
  likes: number
  reposts: number
  replies: number
  minsAgo: number
  reply?: { parent: string; root: string }
  repostBy?: number
  link?: string
  image?: string
  quote?: { ai: number; text: string }
  external?: { uri: string; title: string; description: string; thumb?: string }
}

const DEMO_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#33506a"/><text x="200" y="160" font-size="26" fill="#cfe3f5" text-anchor="middle" font-family="sans-serif">demo image</text></svg>',
  )

function make(s: Spec): FeedItem {
  const [handle, displayName] = AUTHORS[s.ai]
  const uri = `at://did:plc:${handle}/app.bsky.feed.post/${s.id}`
  const created = new Date(BASE - s.minsAgo * 60_000).toISOString()
  const text = s.link ? `${s.text} ${s.link}` : s.text
  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: created,
  }
  if (s.link) {
    const enc = new TextEncoder()
    const byteStart = enc.encode(text.slice(0, text.length - s.link.length)).length
    record.facets = [
      {
        index: { byteStart, byteEnd: byteStart + enc.encode(s.link).length },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: s.link }],
      },
    ]
  }
  if (s.reply) {
    record.reply = {
      parent: { uri: s.reply.parent, cid: `cid-${s.reply.parent}` },
      root: { uri: s.reply.root, cid: `cid-${s.reply.root}` },
    }
  }
  const item: Record<string, unknown> = {
    post: {
      uri,
      cid: `cid-${s.id}`,
      author: { did: `did:plc:${handle}`, handle, displayName },
      record,
      replyCount: s.replies,
      repostCount: s.reposts,
      likeCount: s.likes,
      indexedAt: created,
    },
  }
  if (s.repostBy !== undefined) {
    const [rh, rn] = AUTHORS[s.repostBy]
    item.reason = {
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: { did: `did:plc:${rh}`, handle: rh, displayName: rn },
      indexedAt: created,
    }
  }
  if (s.image) {
    ;(item.post as Record<string, unknown>).embed = {
      $type: 'app.bsky.embed.images#view',
      images: [{ thumb: s.image, fullsize: s.image, alt: 'demo image' }],
    }
  }
  if (s.external) {
    ;(item.post as Record<string, unknown>).embed = {
      $type: 'app.bsky.embed.external#view',
      external: {
        uri: s.external.uri,
        title: s.external.title,
        description: s.external.description,
        thumb: s.external.thumb,
      },
    }
  }
  if (s.quote) {
    const [qh, qn] = AUTHORS[s.quote.ai]
    ;(item.post as Record<string, unknown>).embed = {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: `at://did:plc:${qh}/app.bsky.feed.post/quoted-${s.id}`,
        cid: `cid-quoted-${s.id}`,
        author: { did: `did:plc:${qh}`, handle: qh, displayName: qn },
        value: { $type: 'app.bsky.feed.post', text: s.quote.text, createdAt: created },
        indexedAt: created,
      },
    }
  }
  return item as unknown as FeedItem
}

/** ~25 posts: standalone with varied engagement + one 5-post thread. */
export function demoFeed(): FeedItem[] {
  const specs: Spec[] = []
  const texts = [
    'the semantic layout finally clicks when you stop scrolling',
    'a map of conversations, not a feed of noise',
    'reposting this because it deserves more eyes',
    'quiet post, low engagement, bottom of the graph',
    'hot take that got a lot of replies today',
    'just a normal afternoon thought',
    'the force sim settling into place is oddly satisfying',
    'dismissing a whole thread at once is the dream',
    'engagement on the y-axis makes triage fast',
    'newest on the right, loudest on top',
    'thread collapsing keeps the graph readable',
    'another mid post to fill the queue',
    'testing the config popover overflow',
    'top / recent / mix — pick your poison',
    'auto-cycle is off by default and that is correct',
    'the loudest half plus the newest half',
    'nodes should fill the whole canvas now',
    'a late-night musing about interfaces',
    'small account, big idea, low numbers',
    'the digest view is the everyday mode',
  ]
  for (let i = 0; i < texts.length; i++) {
    specs.push({
      id: `p${i}`,
      ai: i % AUTHORS.length,
      text: texts[i],
      likes: (i * 7) % 40,
      reposts: (i * 3) % 12,
      replies: (i * 5) % 9,
      minsAgo: i * 11 + 3,
      repostBy: i === 2 ? 4 : undefined,
    })
  }
  // Rich content: a link post (facets) and an image post.
  specs.push({ id: 'link', ai: 1, text: 'worth a read', link: 'https://docs.bsky.app', likes: 18, reposts: 5, replies: 2, minsAgo: 8 })
  specs.push({ id: 'img', ai: 3, text: 'a photo from today', image: DEMO_IMG, likes: 26, reposts: 7, replies: 3, minsAgo: 14 })
  specs.push({ id: 'quote', ai: 2, text: 'exactly this — well put', quote: { ai: 5, text: 'You cannot convince me that a technology where I can type this into a text box and expect to get an interesting response is not, at some level, genuinely astonishing — even if you also worry about where it all goes.' }, likes: 19, reposts: 6, replies: 1, minsAgo: 10 })
  specs.push({ id: 'ext', ai: 4, text: 'good writeup', external: { uri: 'https://docs.bsky.app/blog', title: 'Building on the AT Protocol', description: 'A guide to client apps, feeds, and the firehose.', thumb: DEMO_IMG }, likes: 14, reposts: 3, replies: 1, minsAgo: 6 })

  // A 5-post thread rooted at t0 (tests collapsing + "+N" badge).
  const root = 'at://did:plc:alice.bsky.social/app.bsky.feed.post/t0'
  specs.push({ id: 't0', ai: 0, text: 'starting a thread about the graph metaphor', likes: 30, reposts: 8, replies: 4, minsAgo: 25 })
  for (let k = 1; k <= 4; k++) {
    const parent =
      k === 1 ? root : `at://did:plc:alice.bsky.social/app.bsky.feed.post/t${k - 1}`
    specs.push({
      id: `t${k}`,
      ai: 0,
      text: `reply ${k} in the thread, each one a little quieter`,
      likes: 12 - k * 2,
      reposts: 2,
      replies: 1,
      minsAgo: 24 - k,
      reply: { parent, root },
    })
  }
  return specs.map(make)
}
