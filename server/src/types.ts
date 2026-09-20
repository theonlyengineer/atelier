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
  | 'check'
  | 'uncheck'
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

/**
 * Where a capture reads its result from.
 *
 * `auto` is the media path — the element's own source, or the first thing
 * inside it that has one. The rest name a specific property, because "capture
 * what this field currently holds" and "capture what it is prompting for" are
 * different questions and only the person recording knows which they meant.
 */
export type CaptureFrom = 'auto' | 'text' | 'value' | 'placeholder'

/**
 * Whether a value is supplied by the caller or replayed exactly.
 *
 * `dynamic` becomes a named input the agent fills in; `static` is setup the
 * agent never sees, and is deliberately not reported by any MCP tool. Both keep
 * `sampleValue`, because a test run has to have something to type.
 */
export type ValueMode = 'static' | 'dynamic'

export interface Step {
  id: string
  kind: StepKind
  /** Empty for navigate/wait/key. */
  selectors: SelectorCandidate[]
  /**
   * What the person recording called this element, confirmed by them at the
   * moment they pointed at it. It is the step's human name *and* the first
   * selector candidate, which is why a workflow reads like a sentence rather
   * than like a CSS path.
   */
  target?: string
  /** For type/select/navigate/key. May contain a {{input}} placeholder. */
  value?: string
  /** type/select only. Absent means the value is whatever `value` says. */
  valueMode?: ValueMode
  /**
   * The text actually typed while recording, kept whether the value is static
   * or dynamic. A dynamic step stores it so a test run has something to type
   * without anyone inventing a plausible-looking string.
   */
  sampleValue?: string
  /** For a dynamic value: the input name the caller passes it under. */
  inputName?: string
  /** For capture: what kind of artifact, so the extension knows how to extract it. */
  capture?: { as: 'image' | 'text' | 'download'; attribute?: string; from?: CaptureFrom }
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
  /** Everything belongs to exactly one project. */
  projectId: string
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
  /**
   * How long to wait between steps, in milliseconds.
   *
   * Never below a second. Replay already retries a selector until the step's
   * timeout, so this is not about finding an element — it is about the page
   * being *ready* for the next thing after the last one: a framework that
   * re-renders, a handler that runs on the next tick, an animation that has to
   * finish before a click lands where it looks like it will. Those are not
   * waits anything can observe, so the only honest answer is to pause.
   */
  stepDelayMs: number
  createdAt: string
  updatedAt: string
}

export type JobStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  projectId: string
  workflowId: string
  workflowName: string
  inputs: Record<string, string>
  status: JobStatus
  stepIndex: number
  stepCount: number
  /** Human-readable reason the job is parked, shown in the popup. */
  blockedReason: string | null
  error: string | null
  assetIds: string[]
  /** A run started from the dashboard or the popup to check a workflow still
   *  works, using the values recorded with it rather than the caller's. */
  isTest: boolean
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
