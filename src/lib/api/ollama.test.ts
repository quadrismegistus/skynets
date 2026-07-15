import { describe, it, expect } from 'vitest'
import { pickDefaultModel, isMlxModel, formatSize, type OllamaModel } from './ollama'

const M = (name: string, gb: number): OllamaModel => ({ name, size: gb * 1e9 })

describe('pickDefaultModel', () => {
  const models = [M('qwen3.5:9b-mlx', 9), M('llama3.1:8b', 5), M('qwen3.5:2b-mlx', 2), M('gemma3:4b', 3)]

  it('on a Mac, prefers the smallest MLX build', () => {
    expect(pickDefaultModel(models, true)).toBe('qwen3.5:2b-mlx')
  })

  it('off a Mac, excludes MLX and picks the smallest non-MLX', () => {
    expect(pickDefaultModel(models, false)).toBe('gemma3:4b')
  })

  it('on a Mac with no MLX builds, falls back to the smallest overall', () => {
    const noMlx = [M('llama3.1:8b', 5), M('gemma3:4b', 3)]
    expect(pickDefaultModel(noMlx, true)).toBe('gemma3:4b')
  })

  it('off a Mac with only MLX builds, still returns the smallest overall', () => {
    const onlyMlx = [M('qwen3.5:9b-mlx', 9), M('qwen3.5:2b-mlx', 2)]
    expect(pickDefaultModel(onlyMlx, false)).toBe('qwen3.5:2b-mlx')
  })

  it('returns undefined when nothing is installed', () => {
    expect(pickDefaultModel([], true)).toBeUndefined()
  })
})

describe('isMlxModel', () => {
  it('detects mlx anywhere in the name', () => {
    expect(isMlxModel('qwen3.5:4b-mlx')).toBe(true)
    expect(isMlxModel('MLX-community/foo')).toBe(true)
    expect(isMlxModel('llama3.1:8b')).toBe(false)
  })
})

describe('formatSize', () => {
  it('formats GB and MB', () => {
    expect(formatSize(1.9e9)).toBe('1.9 GB')
    expect(formatSize(45e6)).toBe('45 MB')
    expect(formatSize(0)).toBe('')
  })
})
