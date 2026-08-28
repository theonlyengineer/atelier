/**
 * Blob storage. Content-addressed, so the same image arriving twice costs one
 * file — while staying two asset rows, because the prompts that produced them
 * are different and both are worth keeping.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { blobPath } from '../paths.ts'
import * as repo from '../db/repo.ts'
import type { Asset } from '../types.ts'

/** PNG/JPEG/WebP/GIF dimensions from the header, without an image library. */
export function probeDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (buf.length >= 24 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF: little-endian uint16 at offsets 6 and 8.
  if (buf.length >= 10 && (buf.subarray(0, 6).toString() === 'GIF89a' || buf.subarray(0, 6).toString() === 'GIF87a')) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // WebP (VP8X/VP8L/VP8 ) — only the simple VP8X form is worth the code here.
  if (buf.length >= 30 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') {
    if (buf.subarray(12, 16).toString() === 'VP8X') {
      const w = 1 + (buf.readUIntLE(24, 3) & 0xffffff)
      const h = 1 + (buf.readUIntLE(27, 3) & 0xffffff)
      return { width: w, height: h }
    }
  }
  // JPEG: walk the segments to a start-of-frame marker.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]!
      // SOF0..SOF15, excluding the non-frame markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}

export function store(
  data: Buffer,
  meta: { mime: string; jobId?: string | null; workflowName?: string | null; prompt?: string | null; tags?: string[] },
): Asset {
  const sha256 = createHash('sha256').update(data).digest('hex')
  const path = blobPath(sha256)
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  }
  const dims = probeDimensions(data)
  return repo.createAsset({
    sha256,
    mime: meta.mime,
    bytes: data.byteLength,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    jobId: meta.jobId ?? null,
    workflowName: meta.workflowName ?? null,
    prompt: meta.prompt ?? null,
    tags: meta.tags ?? [],
  })
}

export function read(asset: Asset): Buffer {
  return readFileSync(blobPath(asset.sha256))
}

/** Copy an asset into the working tree. The one operation that leaves ~/.atelier. */
export function attach(asset: Asset, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(blobPath(asset.sha256), destination)
}
