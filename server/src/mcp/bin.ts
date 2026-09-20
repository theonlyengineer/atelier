#!/usr/bin/env node
/**
 * The stdio entry point: one process, one Claude Code session.
 *
 * Kept because it is the zero-configuration path — `claude mcp add atelier --
 * node …/bin.js` needs nothing running first, since the first tool call brings
 * the daemon up by itself. The daemon also serves the same tools over HTTP for
 * anyone who would rather point a config file at a running service than have a
 * process spawned for them; both routes build the same server from `tools.ts`.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { httpCall } from './client.ts'
import { createSession } from './session.ts'
import { buildServer } from './tools.ts'

const server = buildServer(createSession(httpCall))

await server.connect(new StdioServerTransport())
