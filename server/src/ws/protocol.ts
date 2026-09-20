/**
 * The extension ↔ daemon wire protocol. Kept deliberately small: every message
 * is one flat object with a `t` discriminator, so the extension can switch on it
 * without a schema library.
 *
 * The mirror of this file is extension/src/protocol.js. Change both.
 */
import type { Job, Step } from '../types.ts'

/* daemon → extension */
export type ServerMsg =
  /** Run one step. The extension acks with step.ok or step.fail. */
  | {
      t: 'job.step'
      jobId: string
      stepIndex: number
      stepCount: number
      step: Step
      /** Replay refuses to act outside these. Sent every step so a compromised
       *  extension state can't widen its own scope. */
      origins: string[]
      workflowName: string
    }
  | { t: 'job.cancelled'; jobId: string }
  | { t: 'job.done'; jobId: string }
  /** Everything the popup renders. Pushed on every state change so the
   *  panel never polls and never computes. */
  | { t: 'state'; jobs: Job[]; drafts: number; workflows: { name: string; produces: string }[] }
  /** A recording became a proposed workflow. The panel shows it for
   *  confirmation; nothing runs until a human activates it. */
  | { t: 'workflow.proposed'; name: string; steps: number; inputs: string[]; produces: string }
  | { t: 'hello.ok'; serverVersion: string }

/* extension → daemon */
export type ClientMsg =
  | {
      t: 'hello'
      profileId: string
      label: string
      browser: string
      /** Chrome's signed-in email when available — lets the daemon map this to a
       *  --profile-directory without asking the human to configure anything. */
      email?: string
    }
  | {
      t: 'step.ok'
      jobId: string
      stepIndex: number
      data?: unknown
      /** Which selector candidate actually resolved. Without this a workflow
       *  degrading from a testid to a positional XPath is indistinguishable
       *  from a healthy one — see core/health.ts. */
      matched?: { strategy: string; score: number }
    }
  | {
      t: 'step.fail'
      jobId: string
      stepIndex: number
      reason: string
      /** true = a human can fix this (login, captcha); false = the workflow is wrong. */
      recoverable: boolean
    }
  | { t: 'job.resume'; jobId: string }
  | { t: 'job.cancel'; jobId: string }
  | { t: 'draft.save'; name: string; description?: string; origins: string[]; raw: unknown }
  /** One step pointed at a new element, to repair a workflow whose page moved
   *  rather than re-recording the whole thing. Only the selectors and the name
   *  change; what the step *does* was decided once and stands. */
  | { t: 'step.repoint'; workflowName: string; stepId: string; pick: unknown }
  /** Ask for a state frame now. The popup opens at an arbitrary moment and
   *  the daemon only pushes on change, so without this a panel opened during a
   *  quiet period renders whatever the service worker last happened to cache. */
  | { t: 'state.request' }
  | { t: 'ping' }
