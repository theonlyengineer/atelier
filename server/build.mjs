/**
 * Build: tsc, then copy the one non-code file.
 *
 * Source uses .ts import specifiers so `node --experimental-strip-types` can run
 * src/ directly for tests; tsc's rewriteRelativeImportExtensions turns those into
 * .js on the way out. schema.sql is data, so tsc ignores it and we copy it here.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'

execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })

mkdirSync('dist/db', { recursive: true })
copyFileSync('src/db/schema.sql', 'dist/db/schema.sql')
console.log('built')
