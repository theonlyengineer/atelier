/**
 * The shared vocabulary. The extension speaks the same shapes over the wire, so
 * changing anything here means changing extension/src/protocol.js too.
 */

/** How to find an element, in descending order of how well it survives a redeploy. */
export type SelectorStrategy =
  | 'testid'      // [data-testid="..."] and friends — put there to be selected
  | 'id'          // #id — stable unless generated
  | 'aria'        // [aria-label="..."] — semantic, survives restyling
  | 'role'        // role + accessible name
  | 'name'        // [name="..."] — form fields
  | 'placeholder'
  | 'text'        // visible text content
  | 'css'         // structural path — brittle, last resort but often the only one
  | 'xpath'

export interface SelectorCandidate {
  strategy: SelectorStrategy
  value: string
  /** 0-100. The validation pass ranks these; replay tries highest first. */
  score: number
}

export type StepKind =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'upload'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'capture'
  | 'manual'

export type WaitCondition =
  | { kind: 'visible'; selectors: SelectorCandidate[] }
  | { kind: 'hidden'; selectors: SelectorCandidate[] }
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'networkIdle'; idleMs: number }
  | { kind: 'delay'; ms: number }

export interface Step {
  id: string
  kind: StepKind
  /** Empty for navigate/wait/key. */
  selectors: SelectorCandidate[]
  /** For type/select/navigate. May contain {{input}} placeholders. */
  value?: string
  /** For capture: what kind of artifact, so the extension knows how to extract it. */
  capture?: { as: 'image' | 'text' | 'download'; attribute?: string }
  /** Checked before the step runs. */
  waitBefore?: WaitCondition
  /** Checked after — this is what turns "click generate" into "click and wait for the image". */
  waitAfter?: WaitCondition
  timeoutMs: number
  /** Why this step exists, for the human reading the workflow later. */
  note?: string
}

export type WorkflowStatus = 'draft' | 'active' | 'disabled'

export interface WorkflowInput {
  name: string
  description: string
  required: boolean
}

export interface Workflow {
  id: string
  name: string
  description: string
  status: WorkflowStatus
  /** Replay refuses to act on a tab outside these origins. Not optional. */
  origins: string[]
  /** Which browser profile recorded this, so we can reconnect to the right one. */
  profileId: string | null
  inputs: WorkflowInput[]
  steps: Step[]
  /** What this workflow produces, so Claude knows whether to reach for it. */
  produces: 'image' | 'text' | 'file' | 'none'
  createdAt: string
  updatedAt: string
}

export type JobStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  workflowId: string
  workflowName: string
  inputs: Record<string, string>
  status: JobStatus
  stepIndex: number
  stepCount: number
  /** Human-readable reason the job is parked, shown in the side panel. */
  blockedReason: string | null
  error: string | null
  assetIds: string[]
  createdAt: string
  updatedAt: string
}

export interface Asset {
  id: string
  sha256: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  jobId: string | null
  workflowName: string | null
  prompt: string | null
  /** What this asset *is*, in words. The prompt says what was asked for; this
   *  says what came back, which is what anything reasoning about the asset
   *  later — an agent picking one to reuse, a person scanning a grid — actually
   *  needs. Written by whoever knows: the agent that made it, or the human. */
  description: string | null
  tags: string[]
  createdAt: string
}
