import { getAgent } from './agent'
import { isDemo } from './demo'

export interface UploadedImage {
  blob: unknown
  alt: string
  aspectRatio?: { width: number; height: number }
}

/** Downscale + re-encode a File to a JPEG under Bluesky's blob size limits. */
async function compress(
  file: File,
): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const MAX = 1600
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.9),
  )
  if (!blob) throw new Error('Image encoding failed')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, mime: 'image/jpeg', width, height }
}

/** Compress + upload one image; returns the blob ref, alt, and aspect ratio. */
export async function uploadImage(file: File, alt: string): Promise<UploadedImage> {
  const { bytes, mime, width, height } = await compress(file)
  const aspectRatio = { width, height }
  if (isDemo()) {
    return { blob: { $type: 'blob', mimeType: mime, size: bytes.length }, alt, aspectRatio }
  }
  const res = await getAgent().uploadBlob(bytes, { encoding: mime })
  return { blob: res.data.blob, alt, aspectRatio }
}
