import { beforeEach, describe, expect, it } from 'vitest'
import { destinationOf, digestConsent } from './digestConsent.svelte'

beforeEach(() => digestConsent.reset())

describe('destinationOf', () => {
  // The whole design rests on this: consent is only asked for when data really
  // does leave the machine, so someone running their own model is never nagged.
  it('treats a local Ollama as never leaving the device', () => {
    expect(destinationOf('ollama', 'http://localhost:11434')).toBe('local')
    expect(destinationOf('ollama', 'http://127.0.0.1:11434')).toBe('local')
    expect(destinationOf('ollama', 'http://0.0.0.0:11434')).toBe('local')
    expect(destinationOf('ollama', undefined)).toBe('local') // the default endpoint
  })

  it('treats a hosted Ollama as leaving the device', () => {
    expect(destinationOf('ollama', 'https://mothtrap.blue/ollama')).toBe('server')
    expect(destinationOf('ollama', 'http://192.168.1.50:11434')).toBe('server')
  })

  it('treats any cloud provider as third-party', () => {
    expect(destinationOf('anthropic', undefined)).toBe('cloud')
  })

  it('assumes a request leaves when the endpoint cannot be parsed', () => {
    // Erring toward "asks unnecessarily" beats erring toward "sends silently".
    expect(destinationOf('ollama', 'http://[not a url')).toBe('server')
  })
})

describe('digestConsent gate', () => {
  it('lets local work through without ever asking', () => {
    expect(digestConsent.allows('ollama', 'http://localhost:11434')).toBe(true)
    expect(digestConsent.pending).toBe(false)
    expect(digestConsent.state).toBe('unasked')
  })

  it('blocks a remote request and raises the dialog exactly once', () => {
    expect(digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')).toBe(false)
    expect(digestConsent.pending).toBe(true)
    expect(digestConsent.destination).toBe('server')
  })

  it('records which destination blocked, so the dialog can name it', () => {
    digestConsent.allows('anthropic')
    expect(digestConsent.destination).toBe('cloud')
  })

  it('permits everything once granted', () => {
    digestConsent.grant()
    expect(digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')).toBe(true)
    expect(digestConsent.allows('anthropic')).toBe(true)
    expect(digestConsent.pending).toBe(false)
  })

  it('stays blocked after declining, and does NOT re-raise the dialog', () => {
    digestConsent.decline()
    expect(digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')).toBe(false)
    // The nagging case: a declined user must not get the modal again every
    // time the live poll brings in a post.
    expect(digestConsent.pending).toBe(false)
  })

  it('still runs local work for someone who declined', () => {
    digestConsent.decline()
    expect(digestConsent.allows('ollama', 'http://localhost:11434')).toBe(true)
  })

  // Declining once used to disable the digest permanently AND silently: allows()
  // won't re-raise the dialog (correctly — that would nag on every poll tick),
  // so without an explicit way back the feature was simply gone.
  it('reports when a decline is what is blocking the digest', () => {
    expect(digestConsent.blocks('ollama', 'https://mothtrap.blue/ollama')).toBe(false)
    digestConsent.decline()
    expect(digestConsent.blocks('ollama', 'https://mothtrap.blue/ollama')).toBe(true)
    // …but not for someone whose model is local, where nothing was ever gated.
    expect(digestConsent.blocks('ollama', 'http://localhost:11434')).toBe(false)
  })

  it('ask() re-opens the choice after a decline', () => {
    digestConsent.decline()
    expect(digestConsent.pending).toBe(false)
    digestConsent.ask('ollama', 'https://mothtrap.blue/ollama')
    expect(digestConsent.pending).toBe(true)
    digestConsent.grant()
    expect(digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')).toBe(true)
  })

  it('ask() stays quiet when nothing would leave the device', () => {
    digestConsent.ask('ollama', 'http://localhost:11434')
    expect(digestConsent.pending).toBe(false)
  })

  // A backdrop click or Escape must not make a lasting privacy decision.
  it('dismissing is not declining', () => {
    digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')
    expect(digestConsent.pending).toBe(true)
    digestConsent.dismiss()
    expect(digestConsent.pending).toBe(false)
    expect(digestConsent.state).toBe('unasked') // NOT 'declined'
    // …and it isn't reported as a block, so the panel doesn't claim the user
    // turned it off when they merely clicked past the dialog.
    expect(digestConsent.blocks('ollama', 'https://mothtrap.blue/ollama')).toBe(false)
  })

  it('a dismissed dialog stays down for the session, not forever', () => {
    digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')
    digestConsent.dismiss()
    // The live poll keeps calling allows(); it must not pop back up each tick.
    digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')
    digestConsent.allows('ollama', 'https://mothtrap.blue/ollama')
    expect(digestConsent.pending).toBe(false)
    // But an explicit request overrides the deferral — the user asked for it.
    digestConsent.ask('ollama', 'https://mothtrap.blue/ollama')
    expect(digestConsent.pending).toBe(true)
  })

  it('require() throws rather than letting a send through', () => {
    expect(() => digestConsent.require('ollama', 'https://mothtrap.blue/ollama')).toThrow(
      /permission/i,
    )
    digestConsent.grant()
    expect(() => digestConsent.require('ollama', 'https://mothtrap.blue/ollama')).not.toThrow()
  })
})
