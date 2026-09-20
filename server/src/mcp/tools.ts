/**
 * The MCP surface. This is the only part of Atelier that Claude Code sees, so
 * the tool descriptions carry the design: what each tool is for, and when not to
 * reach for it.
 *
 * Everything here is a thin call into the daemon. No state lives in the tools
 * themselves — what little there is (which project this session is working in)
 * belongs to the session that is passed in, because one daemon serving MCP over
 * HTTP answers many sessions at once.
 *
 * Built per session rather than once at module scope: an McpServer connects to
 * exactly one transport, so a session gets its own.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { NeedsProject, type Session } from './session.ts'
import type { Asset, Job, Workflow } from '../types.ts'

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

/** How a NeedsProject refusal is put to the model: ask, do not guess. */
const askForProject = (choices: Array<{ slug: string; name: string }>) =>
  fail(
    'This session is not tied to a project yet, and there is more than one.\n\n' +
      'Ask the person you are working with which of these to use, then call use_project ' +
      'with it. Do not choose for them — putting one client\'s work in another client\'s ' +
      'project is not a mistake anyone notices quickly.\n\n' +
      choices.map((p) => `  • ${p.slug} — ${p.name}`).join('\n'),
  )

export function buildServer(session: Session): McpServer {
  // Named exactly as the tools below already call them, so the tool bodies are
  // untouched by the move from module scope to a per-session factory.
  const { call, boundProject, bindProject } = session

  const server = new McpServer({ name: 'atelier', version: '0.1.0' })

  /**
   * Every tool gets the same error handling, applied once here rather than
   * repeated in twenty-two handlers where one would eventually be forgotten.
   *
   * The case that matters is NeedsProject: a session that has not been told where
   * it is working must stop and ask, not pick.
   */
  const registerTool = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: unknown, handler: (...a: never[]) => unknown) =>
    registerTool(name as never, config as never, (async (...args: never[]) => {
      try {
        return await (handler as (...a: never[]) => Promise<unknown>)(...args)
      } catch (e) {
        if (e instanceof NeedsProject) return askForProject(e.choices)
        return fail((e as Error).message)
      }
    }) as never)) as typeof server.registerTool

  /* -------------------------------------------------------------- projects */

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'Every project this machine holds, with what each contains and which one this session is working in. Projects separate one body of work from another — different clients, different sites — and workflows, runs and assets all belong to exactly one. Call this when you do not know where you are.',
      inputSchema: {},
    },
    async () => {
      try {
        const { projects, active } = await call<{ projects: any[]; active: any }>('/api/projects.list', {})
        const here = boundProject()
        return text(
          projects
            .map((p) => {
              const c = p.contents
              const mark = here && here.id === p.id ? '→ ' : '  '
              const dash = active?.id === p.id ? '   [the dashboard is showing this one]' : ''
              return `${mark}${p.slug} — ${p.name}\n      ${c.workflows} workflows · ${c.jobs} runs · ${c.assets} assets · ${c.drafts} recordings${dash}`
            })
            .join('\n') +
            (here
              ? `\n\nThis session is working in "${here.slug}".`
              : '\n\nThis session is not tied to a project yet. Ask which one to use, then call use_project.'),
        )
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'use_project',
    {
      title: 'Work in a project for this session',
      description:
        "Tie this session to a project. Everything afterwards — listing workflows, running them, storing assets — happens inside it. This is per session and does not move the dashboard: the person you are working with may be looking at something else, deliberately. Ask them which project before calling this; do not pick one yourself.",
      inputSchema: { project: z.string().describe('Project slug, name, or id, from list_projects.') },
    },
    async ({ project }) => {
      try {
        const { projects } = await call<{ projects: any[] }>('/api/projects.list', {})
        const hit = projects.find((p) => p.slug === project || p.id === project || p.name === project)
        if (!hit) {
          return fail(
            `No project "${project}". There is: ${projects.map((p) => p.slug).join(', ')}`,
          )
        }
        bindProject({ id: hit.id, name: hit.name, slug: hit.slug })
        return text(`Working in "${hit.name}" (${hit.slug}) for the rest of this session.`)
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create a project',
      description:
        'Start a new body of work — a different client, a different site. It does not become the session\'s project or the dashboard\'s; say so and let the human decide when to move. Existing work is never moved into it.',
      inputSchema: {
        name: z.string().describe('Human-readable, e.g. "Acme redesign". The slug is derived from it.'),
        note: z.string().optional().describe('One line on what this project is for.'),
      },
    },
    async ({ name, note }) => {
      try {
        const { project } = await call<{ project: any }>('/api/projects.create', { name, note })
        return text(
          `Created "${project.name}" (${project.slug}). Nothing has moved into it, and neither this ` +
            `session nor the dashboard has switched to it.`,
        )
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  /* ------------------------------------------------------------- discovery */

  server.registerTool(
    'atelier_status',
    {
      title: 'Is Atelier ready',
      description:
        'Whether the daemon is running and whether a browser is attached to it. Check this before run_workflow: a workflow with no browser attached parks immediately and waits for a human, which is slower than telling them up front. Also reports counts, anything waiting on a human, and any workflow whose selectors have decayed since it was recorded.',
      inputSchema: {},
    },
    async () => {
      try {
        const here = boundProject()
        const o = await call<any>('/api/overview', {})
        const browsers = o.browsers.length
          ? o.browsers.map((b: any) => `${b.label} (${b.browser})`).join(', ')
          : 'none — the extension is not connected'
        const blocked = o.jobs.filter((j: any) => j.status === 'blocked')
        return text(
          (here
            ? `Working in project "${here.slug}" (${here.name}).\n`
            : `This session is not tied to a project yet — call list_projects, ask which one, then use_project.\n`) +
            `Daemon ${o.version} on 127.0.0.1:${o.port}, up ${Math.round(o.uptimeSeconds / 60)}m\n` +
            `Browsers attached: ${browsers}\n` +
            `Workflows: ${o.counts.workflows} active · Drafts awaiting review: ${o.counts.drafts}\n` +
            `Jobs: ${o.jobs.length} in flight (${blocked.length} blocked) · Assets: ${o.counts.assets}` +
            (blocked.length
              ? `\n\nBlocked and waiting for a human:\n` +
                blocked.map((j: any) => `  ${j.workflowName}: ${j.blockedReason}`).join('\n')
              : '') +
            (o.counts.disabled ? `\nDisabled: ${o.counts.disabled} — not listed and cannot run` : '') +
            (o.pendingActivation?.length
              ? `\n\nRecorded and awaiting the human's confirmation in the popup:\n` +
                o.pendingActivation.map((n: string) => `  ${n}`).join('\n')
              : '') +
            (o.unhealthy?.length
              ? `\n\nDecaying — still running, but matching on weaker selectors than recorded:\n` +
                o.unhealthy.map((w: any) => `  ${w.name}: ${w.summary}`).join('\n')
              : ''),
        )
      } catch (e) {
        return fail(
          `The Atelier daemon is not reachable: ${(e as Error).message}\nAsk the human to start it — \`docker compose up -d\` in the Atelier checkout, or \`npm start\` — or to check ~/.atelier/atelierd.log.`,
        )
      }
    },
  )

  server.registerTool(
    'list_workflows',
    {
      title: 'List browser workflows',
      description:
        'List the browser workflows this project can replay, with the inputs each takes and what it produces. Call this before run_workflow — workflow names are per-project and are not guessable. Disabled workflows are not listed and cannot run. If nothing here produces what you need, say so rather than inventing a name; the human records new workflows in the browser extension.',
      inputSchema: {},
    },
    async () => {
      const { workflows } = await call<{ workflows: any[] }>('/api/workflows.list', {
        status: 'active',
      })
      if (!workflows.length) {
        return text(
          'No active workflows in this project. The human records one from the Atelier popup: they point at each element in turn, say what to call it and which action to perform, and Atelier does the clicking. Then they activate it. Nothing is needed from you.',
        )
      }
      const lines = workflows.map((w) => {
        const inputs = w.inputs.length
          ? w.inputs.map((i: any) => `${i.name}${i.required ? '' : '?'}`).join(', ')
          : '(none)'
        const health = w.health?.state && w.health.state !== 'ok' ? `   health: ${w.health.state}` : ''
        const pending = w.status === 'draft' ? '   [awaiting activation in the popup]' : ''
        return `• ${w.name} — ${w.description}\n    produces: ${w.produces}   inputs: ${inputs}   steps: ${w.steps}${health}${pending}`
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
            'Values for the workflow\'s inputs, matching the input names from list_workflows. Long-form values are composed by you and passed whole — the workflow types whatever string it is given and applies no formatting, templating or house style of its own. Fields the human marked as setup are not listed here and are replayed exactly; you neither see nor supply them.',
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
    'test_workflow',
    {
      title: 'Run a workflow with the values it was recorded with',
      description:
        'Replay a workflow using the text the human typed while recording it, rather than values you supply. The way to answer "does this still work" without inventing a plausible-looking input — a test that types something nobody ever typed is testing a different workflow. Works on a draft too, which is how a workflow is checked before it is allowed to run. Produces a real asset, so do not use it in place of run_workflow when you actually want a result.',
      inputSchema: { name: z.string().describe('Workflow name.') },
    },
    async ({ name }) => {
      try {
        const { job } = await call<{ job: Job }>('/api/workflows.test', { name })
        return text(
          `Test run ${job.id} queued for "${name}" with its recorded values. Check job_status for how it went.`,
        )
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'set_workflow_status',
    {
      title: 'Enable or disable a workflow',
      description:
        'Turn a workflow off without deleting it, or back on. A disabled workflow does not appear in list_workflows and refuses to run, but keeps its steps, its history and its health — which is what you want when a site has changed and the workflow is broken for now. Ask the human before disabling something: they recorded it by hand, and the reason it just failed may be a login rather than the workflow.',
      inputSchema: {
        name: z.string(),
        status: z
          .enum(['draft', 'active', 'disabled'])
          .describe('active = runnable, disabled = off but kept, draft = awaiting the human.'),
      },
    },
    async ({ name, status }) => {
      try {
        const { workflow } = await call<{ workflow: Workflow }>('/api/workflows.setStatus', {
          name,
          status,
        })
        return text(`"${workflow.name}" is now ${workflow.status}.`)
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'set_step_value',
    {
      title: 'Change whether a step asks for its value',
      description:
        "Switch one typing step between static — the recorded text, replayed exactly, which you never see or supply — and dynamic, a named input you pass on every run. Also sets the text a test run types. The only edit a recorded workflow takes: what a step *does* is what the human demonstrated and is not changeable, here or anywhere. Use it when a workflow turns out to freeze the one thing that should vary. Two dynamic steps cannot share a name, compared on what the name becomes — \"Same text\", \"SAME Text\" and \"same_text\" are one name — because the caller passes one value and both fields would receive it.",
      inputSchema: {
        name: z.string().describe('Workflow name.'),
        stepId: z.string().describe('Step id, from get_workflow.'),
        valueMode: z.enum(['static', 'dynamic']).optional(),
        sampleValue: z
          .string()
          .optional()
          .describe('What a test run types here. Kept for a dynamic step too.'),
        inputName: z
          .string()
          .optional()
          .describe('For a dynamic step: the name the caller passes the value under.'),
      },
    },
    async ({ name, stepId, valueMode, sampleValue, inputName }) => {
      try {
        const { workflow } = await call<{ workflow: Workflow }>('/api/workflows.setStepValue', {
          name,
          stepId,
          valueMode,
          sampleValue,
          inputName,
        })
        const inputs = workflow.inputs.map((i) => i.name).join(', ') || '(none)'
        return text(`Updated step ${stepId} in "${workflow.name}". It now takes: ${inputs}`)
      } catch (e) {
        return fail((e as Error).message)
      }
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
    'describe_asset',
    {
      title: 'Say what an asset is',
      description:
        'Record, in one or two sentences, what an asset actually shows — not what was asked for. The prompt already records the request; this records the result, and it is what anything choosing between assets later has to go on, including you in a future session. Write one whenever you produce an asset worth keeping. Pass an empty description to clear it.',
      inputSchema: {
        id: z.string().describe('Asset id, from run_workflow or list_assets.'),
        description: z
          .string()
          .max(2000)
          .describe('What the asset shows, plainly. "A rope bridge with its middle planks missing", not "image 1".'),
      },
    },
    async ({ id, description }) => {
      try {
        const { asset } = await call<{ asset: Asset }>('/api/assets.describe', { id, description })
        return text(
          asset.description
            ? `Described ${asset.id}: ${asset.description}`
            : `Cleared the description on ${asset.id}.`,
        )
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

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
        'Recently produced assets, each with the prompt that made it and a description of what it actually is. Read the descriptions before generating anything: reusing an asset that already exists is faster, free, and keeps a set visually consistent. An asset with no description is one nobody can pick from a list — write one with describe_asset when you make it.',
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
            const what = a.description
              ? `\n    ${a.description}`
              : '\n    (no description — nobody can pick this one out of a list)'
            const prompt = a.prompt ? `\n    prompt: ${a.prompt.slice(0, 140)}` : ''
            return `• ${a.id}  ${a.mime}${dims}  ${a.createdAt.slice(0, 10)}${what}${prompt}`
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

  /* --------------------------------------------------------------- health */

  server.registerTool(
    'workflow_health',
    {
      title: 'Is a workflow still finding things the way it was recorded',
      description:
        'Per-step report of which selector each step is actually matching on, compared with the one it was recorded against. Replay falls back through candidates silently, so a workflow can degrade from a stable test id to a positional XPath and keep working right up until it does not. This is how you see that coming. Call it when a workflow starts behaving oddly, before a run that matters, or when the human asks whether anything needs maintenance.',
      inputSchema: {
        name: z.string().optional().describe('One workflow. Omit for all of them.'),
      },
    },
    async ({ name }) => {
      try {
        const { workflows } = await call<{ workflows: any[] }>('/api/workflows.health', name ? { name } : {})
        if (!workflows.length) return text('No workflows to report on.')
        return text(
          workflows
            .map((w) => {
              const head = `${w.name} — ${w.state.toUpperCase()}: ${w.summary}`
              if (!w.degraded.length) return head
              return (
                head +
                '\n' +
                w.degraded.map((s: any) => `    ${s.state}: ${s.note} — ${s.detail}`).join('\n')
              )
            })
            .join('\n\n'),
        )
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'repair_step',
    {
      title: 'Fix one step of a workflow',
      description:
        "Replace one step's selectors, wait or timeout, leaving the rest of the workflow alone. The repair path for a workflow whose page moved — re-recording twenty steps to fix one is the thing this avoids. Health for that step is cleared, since a match recorded against the old selectors says nothing about the new ones. Prefer asking the human to repoint that one step from the popup: they can see the page and you are guessing at a selector. To change a value rather than how the step finds its element, use set_step_value.",
      inputSchema: {
        name: z.string().describe('Workflow name.'),
        stepId: z.string().describe('Step id, from workflow_health or get_workflow.'),
        step: z
          .object({
            selectors: z
              .array(z.object({ strategy: z.string(), value: z.string(), score: z.number() }))
              .optional(),
            value: z.string().optional(),
            timeoutMs: z.number().int().optional(),
            note: z.string().optional(),
          })
          .describe('Only the fields you are changing.'),
      },
    },
    async ({ name, stepId, step }) => {
      try {
        const { workflow } = await call<{ workflow: Workflow }>('/api/workflows.replaceStep', {
          name,
          stepId,
          step,
        })
        return text(`Updated step ${stepId} in "${workflow.name}". Its health is now unverified until the next run.`)
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'get_workflow',
    {
      title: 'Read a workflow in full',
      description:
        'Every step of a workflow with its selectors, waits and ids, plus its current health. Read this before repair_step — you need the step id, and you need to see what the step is doing before changing how it finds things.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      try {
        const res = await call<{ workflow: Workflow; health: any }>('/api/workflows.get', { name })
        return text(JSON.stringify(res, null, 2))
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
        'Raw browser recordings, kept as the record of exactly what the human built. A recording becomes a workflow the moment it is saved, so this is for inspection and recovery — not a queue you are expected to work through. Reach for it when a workflow came out wrong and you want to see what was actually recorded.',
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
        'The recorded steps, each with the name the human confirmed for its element and every selector candidate found alongside it. Use it to diagnose a workflow that came out wrong: compare what was recorded against what the proposal made of it. The proposal is fixed and deterministic, so if the recording is right and the workflow is not, the rules are the bug.',
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
    kind: z.enum([
      'navigate',
      'click',
      'type',
      'select',
      'check',
      'uncheck',
      'upload',
      'key',
      'scroll',
      'wait',
      'capture',
      'manual',
    ]),
    selectors: z.array(selectorSchema).default([]),
    target: z.string().optional().describe('What a person would call this element.'),
    value: z.string().optional(),
    valueMode: z
      .enum(['static', 'dynamic'])
      .optional()
      .describe('dynamic makes it a named input; static replays the recorded text and is never shown to a caller.'),
    sampleValue: z.string().optional().describe('What a test run types here.'),
    inputName: z.string().optional(),
    capture: z
      .object({
        as: z.enum(['image', 'text', 'download']),
        attribute: z.string().optional(),
        from: z.enum(['auto', 'text', 'value', 'placeholder']).optional(),
      })
      .optional(),
    waitBefore: z.any().optional(),
    waitAfter: z.any().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(600_000)
      .default(30_000)
      .describe('How long to keep looking for the element. Replay retries until this runs out, which is what absorbs a page that changes a variable moment after the previous step.'),
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
        'Overwrite the workflow a recording produced, with one you have written yourself. Rarely needed — the recording is already the human\'s own description of each step. Use it when the proposal got something wrong that neither repair_step nor set_step_value can fix. Keep more than one selector per step: replay tries them in score order, and that list is what makes a workflow survive a redeploy.',
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
        'Create or replace a whole workflow by hand, with no recording. For a site simple enough to describe directly. To fix one step of an existing workflow prefer repair_step or set_step_value, and to change how it finds an element prefer having the human repoint that step — the recorder captures selector candidates you cannot guess.',
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

  return server
}
