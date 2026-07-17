// One replay session of the BME280 fixture (BIBLE §5.6). A session:
//   - replays fixture events over time, paced by delayMs / SPEED;
//   - PAUSES after run.plan_generated and after every approval.requested, resuming
//     only when the matching HTTP command arrives;
//   - reject on an approval routes to a short run.stopped alternate ending;
//   - POST /stop at any time emits run.stopped and halts replay.
// The session owns its event log and current status; broadcasting is delegated to
// the caller via onEvent so the server can fan out to WebSocket clients.
import {
  EventSchema,
  type Event,
  type RunStatus,
  type RunSummary,
} from '@boardex/contract';
import { FIXTURE_RUN_ID, type FixtureEntry } from './fixture';

// A command is valid only for certain run states; an invalid command maps to a
// 409 carrying the run's current status (§5.3).
export type CommandResult =
  | { ok: true }
  | { ok: false; error: string; currentStatus: RunStatus };

type ApprovalOutcome = 'approved' | 'rejected';

interface PendingGate {
  kind: 'plan' | 'approval';
  approvalId?: string;
  resolve: (outcome: ApprovalOutcome) => void;
}

export interface RunSessionOptions {
  id: string;
  entries: readonly FixtureEntry[];
  speed: number;
  validateOutbound: boolean;
  // v2.1 (T6.3): the chosen runner model, echoed onto the run.created Run when set.
  model?: string;
  onEvent: (event: Event) => void;
}

// Replace every occurrence of the source recording's runId with this session's
// id. Artifact, step, check and approval ids do not contain the runId, so they
// stay stable. The source id is the recording's own run.created id (FIXTURE_FILE
// recordings carry their own), falling back to the authored fixture's constant.
function rekey(event: Event, fromRunId: string, toRunId: string): Event {
  const json = JSON.stringify(event).split(fromRunId).join(toRunId);
  return EventSchema.parse(JSON.parse(json));
}

// A string that IS an ISO 8601 datetime, entire — log lines and values that merely
// contain digits never match, so only real timestamps shift.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

// Deep-shift every ISO timestamp in the event — the envelope ts AND the payload
// ones (run.createdAt/updatedAt, approval requestedAt, artifact createdAt, …).
// Elapsed reads payload.run.createdAt, so shifting the envelope alone would lie.
function shiftTimestamps(value: unknown, offsetMs: number): unknown {
  if (typeof value === 'string' && ISO_DATETIME.test(value)) {
    return new Date(Date.parse(value) + offsetMs).toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => shiftTimestamps(item, offsetMs));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, shiftTimestamps(entry, offsetMs)]),
    );
  }
  return value;
}

export class RunSession {
  readonly id: string;
  private readonly entries: readonly FixtureEntry[];
  private readonly speed: number;
  private readonly validateOutbound: boolean;
  private readonly model: string | undefined;
  private readonly onEvent: (event: Event) => void;

  private readonly log: Event[] = [];
  private title: string;
  private boardProfileId: string;
  private readonly sourceRunId: string;
  private currentStatus: RunStatus = 'draft';
  private updatedAt: string;
  private nextSeq = 1;

  private terminated = false;
  private pendingGate: PendingGate | undefined;
  // Timers waiting on delayMs; woken early when the session terminates.
  private readonly wakeups = new Set<() => void>();
  // §5.6 (T6.1b): replayed timestamps rebase to replay start — run.created ≈ the
  // POST /runs moment, inter-event deltas preserved — so elapsed reads true
  // during demos. The fixture files stay authored-time; only emission shifts.
  private readonly tsOffsetMs: number;

  constructor(options: RunSessionOptions) {
    this.id = options.id;
    this.entries = options.entries;
    this.speed = options.speed;
    this.validateOutbound = options.validateOutbound;
    this.model = options.model;
    this.onEvent = options.onEvent;
    // Seed a schema-valid RunSummary at POST /runs time (T5.0/F7): the fixture's
    // run.created replays only after its delayMs, and a GET /runs in that window
    // used to serve empty strings — an updatedAt no IsoDateTime parse accepts.
    // Until run.created lands the run is a valid 'draft' row with the story's
    // identity fields, taken from the fixture itself.
    const created = this.entries.find((entry) => entry.event.type === 'run.created')?.event;
    const run = created?.type === 'run.created' ? created.payload.run : undefined;
    this.title = run?.title ?? 'Run';
    this.boardProfileId = run?.boardProfileId ?? 'bp_nucleo_f303re';
    this.sourceRunId = run?.id ?? FIXTURE_RUN_ID;
    this.updatedAt = new Date().toISOString();
    const firstTs = this.entries[0] ? Date.parse(this.entries[0].event.ts) : NaN;
    this.tsOffsetMs = Number.isFinite(firstTs) ? Date.now() - firstTs : 0;
  }

  // Kick off replay. Fire-and-forget: the loop drives itself off timers and gates.
  start(): void {
    void this.replay();
  }

  getEventsAfter(afterSeq: number): Event[] {
    return this.log.filter((event) => event.seq > afterSeq);
  }

  summary(): RunSummary {
    return {
      id: this.id,
      title: this.title,
      status: this.currentStatus,
      boardProfileId: this.boardProfileId,
      updatedAt: this.updatedAt,
    };
  }

  // POST /runs/{id}/plan/approve — valid only while paused at the plan gate.
  approvePlan(): CommandResult {
    if (this.pendingGate?.kind !== 'plan') {
      return this.conflict('run is not awaiting plan approval');
    }
    this.releaseGate('approved');
    return { ok: true };
  }

  // POST /runs/{id}/approvals/{aid} — valid only while paused at that approval.
  resolveApproval(approvalId: string, status: ApprovalOutcome): CommandResult {
    if (this.pendingGate?.kind !== 'approval' || this.pendingGate.approvalId !== approvalId) {
      return this.conflict(`approval "${approvalId}" is not awaiting resolution`);
    }
    this.releaseGate(status);
    return { ok: true };
  }

  // Tear the session down for server shutdown: clear timers and release any
  // pending gate without emitting further events.
  dispose(): void {
    this.finish();
  }

  // POST /runs/{id}/stop — honored at any time while the run is non-terminal.
  stop(): CommandResult {
    if (this.terminated) {
      return this.conflict('run has already reached a terminal state');
    }
    // A stop can beat the fixture's own run.created (curl straight after POST
    // /runs, inside the first delayMs). The stream must still open with the run
    // it stops — a KNOWN-typed log that starts with run.status_changed is
    // unreducible by contract (T5.0 FIX_FIRST F1) — so emit the fixture's
    // run.created first; the replay loop is already parked and never re-sends it.
    if (!this.log.some((event) => event.type === 'run.created')) {
      const created = this.entries.find((entry) => entry.event.type === 'run.created');
      if (created) {
        this.emit(this.rebase(rekey(created.event, this.sourceRunId, this.id)));
      }
    }
    this.emit(this.make('run.status_changed', { status: 'stopped', reason: 'Stopped by user' }));
    this.emit(this.make('run.stopped', { byUser: true }));
    this.finish();
    return { ok: true };
  }

  // --- internals -----------------------------------------------------------

  // Shift a fixture event's authored timestamps into this replay's timeline (§5.6).
  private rebase(event: Event): Event {
    return EventSchema.parse(shiftTimestamps(event, this.tsOffsetMs));
  }

  private async replay(): Promise<void> {
    for (const entry of this.entries) {
      if (this.terminated) return;
      await this.sleep(entry.delayMs / this.speed);
      if (this.terminated) return;

      const event = this.rebase(rekey(entry.event, this.sourceRunId, this.id));
      this.emit(event);

      if (event.type === 'run.plan_generated') {
        await this.gate({ kind: 'plan' });
        if (this.terminated) return;
      } else if (event.type === 'approval.requested') {
        const approvalId = event.payload.approval.id;
        const outcome = await this.gate({ kind: 'approval', approvalId });
        if (this.terminated) return;
        if (outcome === 'rejected') {
          this.emitRejectEnding(approvalId);
          return;
        }
      }
    }
    // Fixture reached its terminal event (run.completed); mark the session done.
    this.finish();
  }

  private emitRejectEnding(approvalId: string): void {
    this.emit(
      this.make('approval.resolved', {
        approvalId,
        status: 'rejected',
        resolvedAt: new Date().toISOString(),
      }),
    );
    this.emit(
      this.make('run.status_changed', { status: 'stopped', reason: 'Approval rejected' }),
    );
    this.emit(this.make('run.stopped', { byUser: true }));
    this.finish();
  }

  // Emit an event: validate (dev mode, fail loud), append to the log, track run
  // status, then broadcast. Fixture events carry their own gapless seq; synthetic
  // events (make) take the next seq. Either way nextSeq advances past this event.
  private emit(rawEvent: Event): void {
    // v2.1 (T6.3): stamp the chosen model onto the run.created Run so the UI can
    // render the run's model (§4 Run.model). Every run.created goes through emit
    // (replay loop and the stop-before-created path), so this is the one seam.
    const event =
      this.model !== undefined && rawEvent.type === 'run.created'
        ? { ...rawEvent, payload: { run: { ...rawEvent.payload.run, model: this.model } } }
        : rawEvent;
    if (this.validateOutbound) {
      // Throws on any non-conforming outbound event — a loud failure by design.
      EventSchema.parse(event);
    }
    this.log.push(event);
    this.updatedAt = event.ts;
    this.nextSeq = event.seq + 1;
    this.applyStatus(event);
    this.onEvent(event);
  }

  private make(type: 'run.status_changed', payload: { status: RunStatus; reason?: string }): Event;
  private make(type: 'run.stopped', payload: { byUser: true }): Event;
  private make(
    type: 'approval.resolved',
    payload: { approvalId: string; status: ApprovalOutcome; resolvedAt: string },
  ): Event;
  private make(type: string, payload: unknown): Event {
    return EventSchema.parse({
      seq: this.nextSeq,
      runId: this.id,
      ts: new Date().toISOString(),
      type,
      payload,
    });
  }

  private applyStatus(event: Event): void {
    switch (event.type) {
      case 'run.created':
        this.title = event.payload.run.title;
        this.boardProfileId = event.payload.run.boardProfileId;
        this.currentStatus = event.payload.run.status;
        break;
      case 'run.status_changed':
        this.currentStatus = event.payload.status;
        break;
      case 'run.completed':
        this.currentStatus = 'completed';
        break;
      case 'run.failed':
        this.currentStatus = 'failed';
        break;
      case 'run.stopped':
        this.currentStatus = 'stopped';
        break;
      default:
        break;
    }
  }

  private gate(gate: { kind: 'plan' | 'approval'; approvalId?: string }): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      if (this.terminated) {
        resolve('rejected');
        return;
      }
      this.pendingGate = { ...gate, resolve };
    });
  }

  private releaseGate(outcome: ApprovalOutcome): void {
    const gate = this.pendingGate;
    this.pendingGate = undefined;
    gate?.resolve(outcome);
  }

  // A cancellable delay: resolves after ms, or immediately when the session ends.
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.terminated) {
        resolve();
        return;
      }
      const wake = (): void => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, ms));
      this.wakeups.add(wake);
    });
  }

  private finish(): void {
    if (this.terminated) return;
    this.terminated = true;
    for (const wake of [...this.wakeups]) wake();
    this.wakeups.clear();
    this.releaseGate('rejected');
  }

  private conflict(error: string): CommandResult {
    return { ok: false, error, currentStatus: this.currentStatus };
  }
}
