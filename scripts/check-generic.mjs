#!/usr/bin/env node
/**
 * The core stays generic.
 *
 * Atelier is a general tool. The moment its code, comments, docs or tool
 * descriptions name a particular site or encode one project's house style, it
 * quietly becomes a tool that only really works for whoever wrote it — and the
 * drift is invisible, because the logic usually stays correct while the words
 * around it rot. That is exactly what happened once: `run_workflow`'s input
 * description instructed every session to prepend a style guide from a path
 * that existed in a single downstream project.
 *
 * Intentions did not hold that line. This does.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])
const CHECK_EXT = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.css', '.html', '.sql'])

/** Names of third-party products, and of the projects that happen to use this.
 *  A general tool that knows any of them by name knows too much. */
const FORBIDDEN = [
  { pattern: /\bchat ?gpt\b/i, why: 'names a specific site' },
  { pattern: /\bopen ?ai\b/i, why: 'names a specific vendor' },
  { pattern: /\bmidjourney\b/i, why: 'names a specific site' },
  { pattern: /\bnotion\b/i, why: 'names a specific product' },
  { pattern: /\bslack\b/i, why: 'names a specific product' },
  { pattern: /theonlyengineer/i, why: 'names a downstream project' },
  { pattern: /\bmentorfresh\b/i, why: 'names a downstream project' },
  { pattern: /image-style-guide/i, why: "a downstream project's file" },
  { pattern: /(^|[^\w-])gtm\//i, why: "a downstream project's path" },
]

/** This file has to name the things it forbids. */
const EXEMPT = new Set(['scripts/check-generic.mjs'])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (CHECK_EXT.has(extname(entry))) yield full
  }
}

const hits = []
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (EXEMPT.has(rel)) continue
  const lines = readFileSync(file, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(line)) hits.push({ rel, line: i + 1, text: line.trim().slice(0, 100), why })
    }
  })
}

if (hits.length === 0) {
  console.log('generic: clean — nothing in the core names a site or a downstream project')
  process.exit(0)
}

console.error(
  `generic: ${hits.length} reference${hits.length === 1 ? '' : 's'} that do not belong in a general tool\n`,
)
for (const h of hits) console.error(`  ${h.rel}:${h.line}  ${h.why}\n    ${h.text}`)
console.error(
  '\nDescribe the class of thing rather than the product ("an editor that keeps its own\n' +
    'document model", not a list of brands). Concrete recipes belong in the project that\n' +
    'uses Atelier, or in a clearly-labelled sample.',
)
process.exit(1)
