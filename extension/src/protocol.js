/**
 * The wire protocol, mirrored from server/src/ws/protocol.ts.
 *
 * Kept as plain constants rather than a schema: the extension loads unpacked
 * with no build step, and a mismatch shows up immediately in the daemon log.
 */

/** Ports the daemon might be on. It writes the real one to ~/.atelier/run/port,
 *  which the extension cannot read — so we probe. 7717 is the default and the
 *  overwhelmingly common case. */
export const CANDIDATE_PORTS = [7717, 7718, 7719, 7720]

export const MSG = {
  // daemon → us
  JOB_STEP: 'job.step',
  JOB_CANCELLED: 'job.cancelled',
  JOB_DONE: 'job.done',
  STATE: 'state',
  HELLO_OK: 'hello.ok',
  // us → daemon
  HELLO: 'hello',
  STEP_OK: 'step.ok',
  STEP_FAIL: 'step.fail',
  JOB_RESUME: 'job.resume',
  JOB_CANCEL: 'job.cancel',
  DRAFT_SAVE: 'draft.save',
  STATE_REQUEST: 'state.request',
  PING: 'ping',
}
