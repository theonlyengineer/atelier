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
  /** Everything the side panel renders. Pushed on every state change so the
   *  panel never polls and never computes. */
  | { t: 'state'; jobs: Job[]; drafts: number; workflows: { name: string; produces: string }[] }
  | { t: 'record.started'; draftName: string }
  | { t: 'record.stopped' }
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
  | { t: 'step.ok'; jobId: string; stepIndex: number; data?: unknown }
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
  | { t: 'draft.save'; name: string; origins: string[]; raw: unknown }
  /** Ask for a state frame now. The side panel opens at an arbitrary moment and
   *  the daemon only pushes on change, so without this a panel opened during a
   *  quiet period renders whatever the service worker last happened to cache. */
  | { t: 'state.request' }
  | { t: 'ping' }
