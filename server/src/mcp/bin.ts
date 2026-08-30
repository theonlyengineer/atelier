#!/usr/bin/env node
/**
 * The MCP surface. This is the only part of Atelier that Claude Code sees, so
 * the tool descriptions carry the design: what each tool is for, and when not to
 * reach for it.
 *
 * Everything here is a thin call into the daemon. No state lives in this process.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { call } from './client.ts'
import type { Asset, Job, Workflow } from '../types.ts'

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

const server = new McpServer({ name: 'atelier', version: '0.1.0' })

/* ------------------------------------------------------------- discovery */

server.registerTool(
  'atelier_status',
  {
    title: 'Is Atelier ready',
    description:
      'Whether the daemon is running and whether a browser is attached to it. Check this before run_workflow: a workflow with no browser attached parks immediately and waits for a human, which is slower than telling them up front. Also reports counts of workflows, drafts, jobs and assets.',
    inputSchema: {},
  },
  async () => {
    try {
      const o = await call<any>('/api/overview', {})
      const browsers = o.browsers.length
        ? o.browsers.map((b: any) => `${b.label} (${b.browser})`).join(', ')
        : 'none — the extension is not connected'
      const blocked = o.jobs.filter((j: any) => j.status === 'blocked')
      return text(
        `Daemon ${o.version} on 127.0.0.1:${o.port}, up ${Math.round(o.uptimeSeconds / 60)}m\n` +
          `Browsers attached: ${browsers}\n` +
          `Workflows: ${o.counts.workflows} active · Drafts awaiting review: ${o.counts.drafts}\n` +
          `Jobs: ${o.jobs.length} in flight (${blocked.length} blocked) · Assets: ${o.counts.assets}` +
          (blocked.length
            ? `\n\nBlocked and waiting for a human:\n` +
              blocked.map((j: any) => `  ${j.workflowName}: ${j.blockedReason}`).join('\n')
            : ''),
      )
    } catch (e) {
      return fail(
        `The Atelier daemon is not reachable: ${(e as Error).message}\nAsk the human to run \`npm start\` in atelier/, or check ~/.atelier/atelierd.log.`,
      )
    }
  },
)

server.registerTool(
  'list_workflows',
  {
    title: 'List browser workflows',
    description:
      'List the recorded browser workflows this machine can replay, with the inputs each takes and what it produces. Call this before run_workflow — workflow names are per-machine and are not guessable. If nothing here produces what you need, say so rather than inventing a name; the human records new workflows in the browser extension.',
    inputSchema: {},
  },
  async () => {
    const { workflows } = await call<{ workflows: any[] }>('/api/workflows.list', {
      status: 'active',
    })
    if (!workflows.length) {
      return text(
        'No active workflows. The human records one by clicking "Record a workflow" in the Atelier side panel, then it needs a review pass (list_drafts).',
      )
    }
    const lines = workflows.map((w) => {
      const inputs = w.inputs.length
        ? w.inputs.map((i: any) => `${i.name}${i.required ? '' : '?'}`).join(', ')
        : '(none)'
      return `• ${w.name} — ${w.description}\n    produces: ${w.produces}   inputs: ${inputs}   steps: ${w.steps}`
    })
    return text(lines.join('\n'))
  },
)

/* ----------------------------------------------------------------- runs */

server.registerTool(
  'run_workflow',
  {
    title: 'Run a browser workflow',
    description:
      'Replay a recorded workflow in the human\'s browser and return whatever it produced. Waits for the result by default. If the job parks — sign-in needed, captcha, browser closed — this returns immediately saying so, the human is notified in their browser, and you should tell them what is waiting rather than retrying. Re-running after they fix it is not needed: the job resumes itself.',
    inputSchema: {
      name: z.string().describe('Workflow name from list_workflows.'),
      inputs: z
        .record(z.string())
        .optional()
        .describe(
          'Values for the workflow\'s inputs, matching the input names from list_workflows. Long-form values are composed by you and passed whole — the workflow types whatever string it is given and applies no formatting, templating or house style of its own.',
        ),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe('How long to wait for completion. Default 120. Use 0 to queue and return.'),
    },
  },
  async ({ name, inputs, wait_seconds }) => {
    let job: Job
    try {
      ;({ job } = await call<{ job: Job }>('/api/workflows.run', { name, inputs: inputs ?? {} }))
    } catch (e) {
      return fail((e as Error).message)
    }

    const deadline = Date.now() + (wait_seconds ?? 120) * 1000
    while (Date.now() < deadline) {
      const { job: latest } = await call<{ job: Job }>('/api/jobs.status', { id: job.id })
      job = latest
      if (job.status === 'blocked') {
        return text(
          `Job ${job.id} is waiting for the human.\n\n  ${job.blockedReason}\n\n` +
            `It is parked at step ${job.stepIndex + 1} of ${job.stepCount} and resumes on its own once they act — do not re-run it. Tell them what it needs.`,
        )
      }
      if (job.status === 'failed') return fail(`Job failed at step ${job.stepIndex + 1}: ${job.error}`)
      if (job.status === 'cancelled') return text(`Job ${job.id} was cancelled.`)
      if (job.status === 'done') break
      await new Promise((r) => setTimeout(r, 1000))
    }

    if (job.status !== 'done') {
      return text(
        `Job ${job.id} is still running (step ${job.stepIndex + 1}/${job.stepCount}). Check job_status when you need the result.`,
      )
    }
    if (!job.assetIds.length) return text(`Job ${job.id} finished and produced no asset.`)

    const assets = await Promise.all(
      job.assetIds.map((id) => call<{ asset: Asset }>('/api/assets.get', { id })),
    )
    const lines = assets.map(({ asset }) => {
      const dims = asset.width ? ` ${asset.width}×${asset.height}` : ''
      return `  ${asset.id}  ${asset.mime}${dims}  ${Math.round(asset.bytes / 1024)}kB`
    })
    return text(
      `Job ${job.id} done. Produced:\n${lines.join('\n')}\n\nUse save_asset to write one into the repo.`,
    )
  },
)

server.registerTool(
  'list_jobs',
  {
    title: 'List recent jobs',
    description:
      'Recent workflow runs and their outcomes. Use it to find a job whose id you lost, or to see whether something is parked waiting for the human.',
    inputSchema: {
      statuses: z
        .array(z.enum(['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']))
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ statuses, limit }) => {
    const { jobs } = await call<{ jobs: Job[] }>('/api/jobs.list', { statuses, limit })
    if (!jobs.length) return text('No jobs.')
    return text(
      jobs
        .map(
          (j) =>
            `• ${j.id}  ${j.workflowName}  ${j.status}  step ${j.stepIndex}/${j.stepCount}` +
            (j.blockedReason ? `\n    blocked: ${j.blockedReason}` : '') +
            (j.error ? `\n    error: ${j.error}` : '') +
            (j.assetIds.length ? `\n    assets: ${j.assetIds.join(', ')}` : ''),
        )
        .join('\n'),
    )
  },
)

server.registerTool(
  'resume_job',
  {
    title: 'Resume a parked job',
    description:
      'Retry the step a blocked job stopped on. Only call this after the human says they have fixed whatever it was waiting for — signing in, solving a captcha, opening the browser. Resuming into the same obstacle just parks it again.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const { job } = await call<{ job: Job }>('/api/jobs.resume', { id })
      return text(`Resumed ${job.workflowName} at step ${job.stepIndex + 1}; status is now ${job.status}.`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

server.registerTool(
  'cancel_job',
  {
    title: 'Cancel a job',
    description: 'Stop a running or parked job. Its assets, if any, are kept.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const { job } = await call<{ job: Job }>('/api/jobs.cancel', { id })
      return text(`Cancelled ${job?.workflowName ?? id}.`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

server.registerTool(
  'job_status',
  {
    title: 'Check a workflow job',
    description:
      'Status and step-by-step history of a job. Use it for a job you queued with wait_seconds: 0, or to see why one failed.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const { job, events } = await call<{ job: Job; events: any[] }>('/api/jobs.status', { id })
      const history = events
        .slice(-12)
        .map((e) => `  ${e.at.slice(11, 19)}  ${e.kind}  ${e.detail}`)
        .join('\n')
      return text(
        `${job.workflowName} — ${job.status} (step ${job.stepIndex}/${job.stepCount})` +
          (job.blockedReason ? `\nBlocked: ${job.blockedReason}` : '') +
          (job.error ? `\nError: ${job.error}` : '') +
          (job.assetIds.length ? `\nAssets: ${job.assetIds.join(', ')}` : '') +
          `\n\n${history}`,
      )
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

/* --------------------------------------------------------------- assets */

server.registerTool(
  'save_asset',
  {
    title: 'Write an asset into the repo',
    description:
      'Copy a stored asset to a path in the working tree — the last step after generating an image. The path is written as given, so pass a repo-relative or absolute path including the filename and extension.',
    inputSchema: {
      id: z.string().describe('Asset id from run_workflow or list_assets.'),
      path: z.string().describe('Destination path, including filename.'),
    },
  },
  async ({ id, path }) => {
    try {
      const { asset } = await call<{ asset: Asset }>('/api/assets.attach', { id, path })
      return text(`Wrote ${asset.mime} (${Math.round(asset.bytes / 1024)}kB) to ${path}`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

server.registerTool(
  'list_assets',
  {
    title: 'List generated assets',
    description:
      'Recently produced assets with the prompt that made each one. Use it to reuse an image instead of regenerating it, or to find something produced in an earlier session.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
      tag: z.string().optional().describe('Filter by tag; workflows tag their output with their own name.'),
    },
  },
  async ({ limit, tag }) => {
    const { assets } = await call<{ assets: Asset[] }>('/api/assets.list', { limit, tag })
    if (!assets.length) return text('No assets yet.')
    return text(
      assets
        .map((a) => {
          const dims = a.width ? ` ${a.width}×${a.height}` : ''
          const prompt = a.prompt ? `\n    ${a.prompt.slice(0, 160)}` : ''
          return `• ${a.id}  ${a.mime}${dims}  ${a.createdAt.slice(0, 10)}${prompt}`
        })
        .join('\n'),
    )
  },
)

server.registerTool(
  'delete_workflow',
  {
    title: 'Delete a workflow',
    description:
      'Remove a workflow by name. Assets it produced are kept — the prompt that made an image is worth having after the recipe is gone. Confirm with the human first: a workflow is a recording they made by hand and cannot be regenerated.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    try {
      await call('/api/workflows.delete', { name })
      return text(`Deleted workflow "${name}". Its assets were kept.`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

/* ------------------------------------------------- recording → workflow */

server.registerTool(
  'list_drafts',
  {
    title: 'List recordings awaiting review',
    description:
      'Raw browser recordings the human has made that are not yet runnable workflows. Each needs a review pass: read it with get_draft, then promote_draft. Check this when the human says they recorded something.',
    inputSchema: {},
  },
  async () => {
    const { drafts } = await call<{ drafts: any[] }>('/api/drafts.list', {})
    if (!drafts.length) return text('No drafts awaiting review.')
    return text(
      drafts.map((d) => `• ${d.id}  "${d.name}"  recorded ${d.created_at.slice(0, 16)}`).join('\n'),
    )
  },
)

server.registerTool(
  'get_draft',
  {
    title: 'Read a recording',
    description:
      'The raw captured action trace, with every selector candidate the recorder found per element. Read this, then call promote_draft with a cleaned-up workflow: pick the most stable selector for each step, add waits where the page needs time (especially after the action that triggers generation), replace recorded input text with {{placeholders}}, and drop steps that were incidental clicking.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const { draft } = await call<{ draft: any }>('/api/drafts.get', { id })
      return text(JSON.stringify(draft, null, 2))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

const selectorSchema = z.object({
  strategy: z.enum(['testid', 'id', 'aria', 'role', 'name', 'placeholder', 'text', 'css', 'xpath']),
  value: z.string(),
  score: z.number().min(0).max(100),
})

const stepSchema = z.object({
  id: z.string(),
  kind: z.enum(['navigate', 'click', 'type', 'select', 'upload', 'key', 'scroll', 'wait', 'capture', 'manual']),
  selectors: z.array(selectorSchema).default([]),
  value: z.string().optional(),
  capture: z
    .object({ as: z.enum(['image', 'text', 'download']), attribute: z.string().optional() })
    .optional(),
  waitBefore: z.any().optional(),
  waitAfter: z.any().optional(),
  timeoutMs: z.number().int().min(100).max(600_000).default(15_000),
  note: z.string().optional(),
})

const workflowSchema = z.object({
  name: z.string().describe('kebab-case, unique, and stable — Claude calls it by this name.'),
  description: z.string(),
  status: z.enum(['draft', 'active', 'disabled']).default('active'),
  origins: z
    .array(z.string())
    .min(1)
    .describe(
      'Origins this workflow may act on, e.g. https://example.com. Replay refuses outside them, so keep it to exactly the site involved.',
    ),
  inputs: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean() })),
  steps: z.array(stepSchema),
  produces: z.enum(['image', 'text', 'file', 'none']),
})

server.registerTool(
  'promote_draft',
  {
    title: 'Turn a recording into a workflow',
    description:
      'Save a reviewed recording as a runnable workflow and mark the draft done. Keep more than one selector per step where the recorder found alternatives — replay tries them in score order, and that is what makes a workflow survive a redeploy of the site.',
    inputSchema: { draftId: z.string(), workflow: workflowSchema },
  },
  async ({ draftId, workflow }) => {
    try {
      const { workflow: saved } = await call<{ workflow: Workflow }>('/api/drafts.promote', {
        draftId,
        workflow,
      })
      return text(`Saved workflow "${saved.name}" with ${saved.steps.length} steps (${saved.status}).`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

server.registerTool(
  'delete_draft',
  {
    title: 'Discard a recording',
    description:
      'Delete a draft that will not be promoted — a mis-recording, or one superseded by a better take. Say what was wrong with it when you tell the human, so they know what to do differently.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      await call('/api/drafts.delete', { id })
      return text(`Discarded draft ${id}.`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

server.registerTool(
  'define_workflow',
  {
    title: 'Write a workflow by hand',
    description:
      'Create or replace a workflow without a recording. Use it to fix a step in an existing workflow, or for a site simple enough to describe directly. Prefer promote_draft when a recording exists — the recorder captures selectors you cannot guess.',
    inputSchema: { workflow: workflowSchema },
  },
  async ({ workflow }) => {
    try {
      const { workflow: saved } = await call<{ workflow: Workflow }>('/api/workflows.save', {
        workflow,
      })
      return text(`Saved workflow "${saved.name}" with ${saved.steps.length} steps (${saved.status}).`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
)

await server.connect(new StdioServerTransport())
