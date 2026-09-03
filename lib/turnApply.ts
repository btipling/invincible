/**
 * E20 (plan #814) — the shared SSE event-apply consumer for `runHarnessTurn`.
 *
 * The inline `onStreamEvent` table in `lib/harnessChat.ts` was the single
 * consumer fed by TWO producers — the legacy `/api/agent` stream
 * (`sendAgentStreamFn`) and the durable attach stream (`turnApi.attachTurnStream`,
 * E19 #813). It closed over ~20 mutable locals of the turn scope, so it could
 * not be shared or unit-tested. This module relocates that exact table
 * VERBATIM behind one state bag:
 *
 * - `TurnApplyCtx` — the captured state (session-under-construction, cursor,
 *   fail-closed paint gate, dedup state, live tool card, segment buffers) plus
 *   caller-owned writers (`patchSession` + plan #814 fold/push/git/truncate).
 * - `createApplyTurnEvent(bridge, ctx)` — returns the `onEvent` both producers
 *   pass. Behavior parity is the lock: byte-for-byte the same `next` mutations,
 *   bridge writes, and side-effect calls the inline table performed.
 *
 * Reuses the E19 helpers (`lib/turnAttach.ts`). Ring/truncate/status writers
 * (`foldStatusSlots`, `pushSkillRow`, `refreshGitStatusSlot`, collapse/truncate,
 * `recordLiveCwd`) live on the ctx so this module never value-imports
 * `harnessChat` (E19's `turnAttach` rule; plan #814 writer callbacks).
 * Not in this module: producer transport, retry classification, session
 * persist shape — those stay in `runHarnessTurn`.
 */
import type { AgentStreamEvent } from './agent/agentStream';
import { sanitizeUsageSummary } from './agent/usageSummary';
import {
  applyResolvedProvider,
  formatResolvedProviderLabel,
} from './agent/resolvedProvider';
import { isRedisSafeOpaqueId, normalizeSessionCwd, sanitizeResolvedProvider } from './sessionCloudCaps';
import { appendMessage, type SessionSnapshot } from './sessionStore';
import { scheduleImagesFromMarkdown } from './harnessImages';
import { HarnessBridge, MessageKind } from './harnessBridge';
import type { LastUiKind, LiveCwdSource } from './harnessChat';
import {
  addToolResult,
  addToolStart,
  createToolRunGroup,
  encodeToolRun,
  hasRunningTool,
  toolRunIsFull,
  type ToolRunGroup,
} from './toolRun';
import {
  bumpStreamCursor,
  shouldSkipToolResult,
  shouldSkipToolStart,
  skillAlreadyHydrated,
  textDeltaDedup,
  type HydratedToolItem,
} from './turnAttach';

/**
 * The shared mutable apply state — the exact locals the inline `onStreamEvent`
 * table captured, plus the writers only the turn scope owns. Both producers
 * (legacy `/api/agent` stream + durable attach) construct ONE of these and pass
 * the SAME `onEvent` so behavior is identical by construction (plan #814).
 *
 * Invariants carried over verbatim (dropping any is a regression):
 * - `streamPainted` — fail-closed retry gate (plan #759); arms on any
 *   ring-painting event, monotonic within the turn.
 * - `heapC` — this-heap SSE-frame cursor (plan #813/E19); advanced per parsed
 *   frame INCLUDING skipped-by-dedup events; persisted as `turnStreamCursor`.
 * - `replayedStarts`/`replayedResults` + `hydratedAssistant`/`hydratedTools` —
 *   cold-attach dedup state (skip policy inputs, never reset mid-turn).
 * - `toolRunGroup`/`openToolRunId`/`lastRingRowIsToolRun` — live kind-6 card
 *   aggregation (#433); `lastUiKind` — the single boundary predicate (#364).
 */
export type TurnApplyCtx = {
  /** Session under construction (the turn's working copy). Replaced per event. */
  next: SessionSnapshot;
  /** Plan #813 (E19) — this-heap SSE-frame count, advanced per parsed frame. */
  heapC: number;
  /**
   * plan #759 / adversarial-review Major — once the LIVE stream has painted ANY
   * ring content past the user line, a later failure is NOT retryable.
   * Monotonic — set once, never reset within the turn.
   */
  streamPainted: boolean;
  /** Cold-attach dedup flag (`opts.attach.dedup === true`). */
  dedup: boolean;
  /** Hydrated this-run assistant text (cold attach); `''` otherwise. */
  hydratedAssistant: string;
  /** Hydrated this-run tool items (cold attach); `[]` otherwise. */
  hydratedTools: HydratedToolItem[];
  /** Replay counters per tool name (skip-policy input, E19). */
  replayedStarts: Record<string, number>;
  replayedResults: Record<string, number>;
  /** Open live tool-run group (protocol v11 / #433). */
  toolRunGroup: ToolRunGroup;
  /** Session id of the current open live tool card (patched in place). */
  openToolRunId: string | null;
  /** Whether the last ring row the host wrote is its own open kind-6 card. */
  lastRingRowIsToolRun: boolean;
  /** Last ring-row kind — the single boundary-predicate driver (plan #364). */
  lastUiKind: LastUiKind;
  /** Assistant bubble state (all stream segments + the open bubble only). */
  assistantStarted: boolean;
  /** Full assistant text for session/result (all stream segments). */
  assistantAcc: string;
  /** Text for the currently open assistant ring bubble only. */
  assistantSegment: string;
  assistantSegmentOpen: boolean;
  /**
   * Boundary whitespace buffered between streamed assistant segments (#387):
   * reattached as LEADING whitespace on the next opened segment so the canvas
   * reconstitutes the authoritative text exactly. Never opens a bubble.
   */
  pendingAssistantWs: string;
  /** Thinking bubble state (ephemeral UI — never in SessionStore). */
  thinkingSegment: string;
  thinkingSegmentOpen: boolean;
  /** SSE terminal (`done`/`error`) seen — gates the D18 incomplete fold. */
  sawStreamTerminal: boolean;
  /** Provider `finishReason` from the terminal `done` (upstream #881
   * truncated-finish defense). Captured here because the `done` handler lives
   * in this consumer post-E20; `runHarnessTurn` re-syncs it post-stream and
   * converts a provider-refusal success (`content-filter`/`error`) to an
   * Error via `isProviderRefusalFinish`/`truncatedFinishError`. Optional: absent
   * until a `done` carrying a string `finishReason` arrives. */
  doneFinishReason?: string | undefined;
  /** Last confirmed-successful `change_dir` cwd this turn (#464 / plan #465). */
  liveCwd: LiveCwdSource;
  /**
   * Mid-turn session persist (cwd change / sandbox switch / usage fold).
   * Caller-owned: applies the #857 cold-backup gate (never PUT a truncated
   * prefix-only transcript before the first paint) and forwards to
   * `opts.onSessionPatch`.
   */
  patchSession: (s: SessionSnapshot) => void;
  /** Caller abort signal, forwarded to the fail-soft git slot refresh. */
  signal?: AbortSignal;
  /** Status-slot fold (sandbox / cwd / context). Caller: `foldStatusSlots`. */
  foldStatusSlots: (bridge: HarnessBridge, session: SessionSnapshot) => void;
  /** Display-only skill row (kind 7) + session mirror. Caller: `pushSkillRow`. */
  pushSkillRow: (
    bridge: HarnessBridge,
    session: SessionSnapshot,
    ev: { action: 'attach' | 'detach'; slug: string; ok: boolean },
  ) => SessionSnapshot;
  /** Fail-soft git-slot probe. Caller: `refreshGitStatusSlot`. */
  refreshGitStatusSlot: (
    bridge: HarnessBridge,
    session: SessionSnapshot,
    signal?: AbortSignal,
  ) => Promise<void>;
  collapseThinkingDisplay: (text: string) => string;
  truncateThinkingDisplay: (text: string) => string;
  truncateToolTraceSummary: (text: string) => string;
  recordLiveCwd: (
    state: LiveCwdSource,
    confirmedCwd: string | undefined,
  ) => LiveCwdSource;
};

/**
 * Clear the live tool-card state (#433): the next tool opens a FRESH card at
 * `1`. Called on assistant/thinking boundaries, group-full rolls, and both
 * turn-end paths (live cards are already painted + session-mirrored per event).
 */
export function resetLiveToolStreak(ctx: TurnApplyCtx): void {
  ctx.lastRingRowIsToolRun = false;
  ctx.openToolRunId = null;
  ctx.toolRunGroup = createToolRunGroup();
}

/**
 * Soft-close the open thinking segment: keep the full monologue (soft-trim only
 * to Wasm MAX_MSG_LEN via `collapseThinkingDisplay`), then clear the segment.
 * No-op when no thinking row is open (safe to call at every turn end).
 */
export function closeThinkingSegment(
  bridge: HarnessBridge,
  ctx: TurnApplyCtx,
): void {
  // Keep full monologue visible — do not collapse to a one-liner.
  // Soft-trim only to Wasm MAX_MSG_LEN via collapseThinkingDisplay.
  if (ctx.thinkingSegmentOpen && ctx.thinkingSegment) {
    const kept = ctx.collapseThinkingDisplay(ctx.thinkingSegment);
    if (kept !== ctx.thinkingSegment) {
      if (!bridge.updateLastMessage(MessageKind.Thinking, kept)) {
        /* last row changed — leave as-is */
      }
    }
  }
  ctx.thinkingSegmentOpen = false;
  ctx.thinkingSegment = '';
}

/**
 * Build the shared `onEvent` consumer over `ctx`. Returned once per turn and
 * passed as `onEvent:` to BOTH producers — the exact relocated inline table.
 * The sibling closures below are the relocated per-turn helpers; they read and
 * write the ctx state bag exactly as the inline closures mutated their locals.
 */
export function createApplyTurnEvent(
  bridge: HarnessBridge,
  ctx: TurnApplyCtx,
): (ev: AgentStreamEvent) => Promise<void> {
  const closeAssistantSegment = () => {
    ctx.assistantSegmentOpen = false;
    ctx.assistantSegment = '';
  };

  const growThinking = (chunk: string) => {
    if (!chunk) return;
    // A Thinking row is a NON-tool ring row. Once it lands last it becomes a
    // physical separator (#433 locked rule): the next tool opens a NEW card at
    // `1` rather than growing an open tool card below it. The last painted
    // tool card is already committed live (painted on its event), so we only
    // clear the live-paint flag here — never buffer the tool group in host
    // memory until thinking closes (commit-once is removed).
    ctx.lastUiKind = 'thinking';
    ctx.lastRingRowIsToolRun = false;
    // Thinking is ephemeral UI — do not append to SessionStore.
    // Close assistant so a later text_delta cannot updateLast-fail and
    // re-push a full duplicated assistant segment (text→reason→text).
    closeAssistantSegment();

    if (ctx.thinkingSegmentOpen) {
      ctx.thinkingSegment = ctx.truncateThinkingDisplay(ctx.thinkingSegment + chunk);
      if (!bridge.updateLastMessage(MessageKind.Thinking, ctx.thinkingSegment)) {
        bridge.pushMessage(MessageKind.Thinking, ctx.thinkingSegment);
      }
      return;
    }

    ctx.thinkingSegment = ctx.truncateThinkingDisplay(chunk);
    bridge.pushMessage(MessageKind.Thinking, ctx.thinkingSegment);
    ctx.thinkingSegmentOpen = true;
  };

  const growAssistant = (chunk: string) => {
    // Whitespace-only text_delta is NOT a boundary (plan #364): it never
    // opens an assistant bubble, closes thinking, or flushes a tool streak.
    // But it MUST be accumulated faithfully (into the message buffer and any
    // open bubble) so a boundary `\n\n` between streamed segments survives
    // into `finalizeAssistant`. If we dropped it, the multi-segment tail-slice
    // would mis-subtract and glue the finished row against a well-formed
    // authoritative `done.text` (#387 host seam, phase-1 red fixture).
    if (!chunk.trim()) {
      ctx.assistantAcc += chunk;
      if (ctx.assistantSegmentOpen) {
        ctx.assistantSegment += chunk;
        if (
          !bridge.updateLastMessage(MessageKind.Assistant, ctx.assistantSegment)
        ) {
          bridge.pushMessage(MessageKind.Assistant, ctx.assistantSegment);
        }
      } else if (ctx.assistantStarted) {
        // Boundary whitespace that arrives AFTER the previous segment closed
        // (e.g. a tool closed the bubble): buffer it so the next opened
        // assistant segment leads with it, keeping the inter-segment blank
        // line on the canvas (#387 after-close residual). Never opens an
        // empty bubble on its own (plan #364). Leading whitespace before the
        // FIRST segment (`assistantStarted === false`) is not buffered — it is
        // a tokenization artifact that the authoritative final rewrites.
        ctx.pendingAssistantWs += chunk;
      }
      return;
    }
    closeThinkingSegment(bridge, ctx);
    ctx.assistantAcc += chunk;
    if (!ctx.assistantSegmentOpen) {
      // Real assistant text begins. The open tool card is already painted live
      // on its events (not buffered), so this is a boundary reset only — clear
      // the live-paint flag so a later tool opens a NEW card; never re-push
      // the already-committed tool row.
      resetLiveToolStreak(ctx);
      // Reattach any boundary whitespace buffered after the previous segment
      // closed (tool boundary) so the completed canvas equals authoritative.
      const leading = ctx.pendingAssistantWs;
      ctx.pendingAssistantWs = '';
      ctx.assistantSegment = leading + chunk;
      bridge.pushMessage(MessageKind.Assistant, ctx.assistantSegment);
      ctx.assistantSegmentOpen = true;
      ctx.assistantStarted = true;
      // Real assistant text is a boundary — later tools open a new group.
      ctx.lastUiKind = 'assistant';
      return;
    }
    ctx.assistantSegment += chunk;
    if (!bridge.updateLastMessage(MessageKind.Assistant, ctx.assistantSegment)) {
      // Last row is not assistant — open a fresh bubble with this segment.
      bridge.pushMessage(MessageKind.Assistant, ctx.assistantSegment);
    }
    ctx.lastUiKind = 'assistant';
  };

  const finalizeAssistant = (finalText: string) => {
    const text = finalText.trim();
    if (!text) return;
    if (!ctx.assistantStarted) {
      // The open tool card is already painted live on its events; reset the
      // flag so the assistant reply (and any later tool) is a fresh boundary.
      resetLiveToolStreak(ctx);
      bridge.pushMessage(MessageKind.Assistant, text);
      ctx.assistantStarted = true;
      ctx.assistantSegmentOpen = true;
      ctx.assistantSegment = text;
      ctx.lastUiKind = 'assistant';
    } else if (ctx.assistantSegmentOpen) {
      // Single continuous segment: rewrite to server final when it differs.
      if (ctx.assistantAcc === ctx.assistantSegment) {
        if (text !== ctx.assistantSegment) {
          if (!bridge.updateLastMessage(MessageKind.Assistant, text)) {
            bridge.pushMessage(MessageKind.Assistant, text);
          }
        }
      } else {
        // Multi-segment turn: adjust only the open tail if final extends it.
        const prefixLen = Math.max(
          0,
          ctx.assistantAcc.length - ctx.assistantSegment.length,
        );
        const prefix = ctx.assistantAcc.slice(0, prefixLen);
        if (text.startsWith(prefix) && text.length >= prefixLen) {
          const tail = text.slice(prefixLen);
          if (tail && tail !== ctx.assistantSegment) {
            if (!bridge.updateLastMessage(MessageKind.Assistant, tail)) {
              bridge.pushMessage(MessageKind.Assistant, tail);
            }
            ctx.assistantSegment = tail;
          }
        }
        // else: leave streamed segments as-is; session still gets full text
      }
    } else {
      // Stream ended on a tool line — only push if final adds unseen text.
      if (text !== ctx.assistantAcc) {
        bridge.pushMessage(MessageKind.Assistant, text);
        ctx.assistantSegmentOpen = true;
        ctx.assistantSegment = text;
      }
    }
    ctx.assistantAcc = text;
    scheduleImagesFromMarkdown(bridge, text);
  };

  /**
   * Paint the current in-memory group as the live kind-6 card: grow the open
   * card in place when `lastRingRowIsToolRun` is true, else push a fresh one
   * at `1`. Mirrors the ring into the session (patch the open card / append a
   * new one) so a mid-turn cancel or reload never loses the live card.
   */
  const livePaintToolRun = () => {
    const payload = encodeToolRun(ctx.toolRunGroup);
    if (!payload) return;
    if (ctx.lastRingRowIsToolRun) {
      // Grow the open card. Guard the rare impossible case where the last row
      // is not our tool card (a raced ring write): never a stale silent bag —
      // open a fresh card instead of duplicating state.
      if (!bridge.updateLastMessage(MessageKind.ToolRun, payload)) {
        bridge.pushMessage(MessageKind.ToolRun, payload);
        ctx.next = appendMessage(ctx.next, 'tool_run', payload);
        ctx.openToolRunId = ctx.next.messages[ctx.next.messages.length - 1]?.id ?? null;
      } else if (ctx.openToolRunId != null) {
        // Patch the open card's session row in place (same id anchor) so
        // session == ring at every instant.
        ctx.next = {
          ...ctx.next,
          messages: ctx.next.messages.map((m) =>
            m.id === ctx.openToolRunId ? { ...m, text: payload } : m,
          ),
          updatedAt: Date.now(),
        };
      } else {
        // No anchor yet (shouldn't happen) — append a fresh row and track it.
        ctx.next = appendMessage(ctx.next, 'tool_run', payload);
        ctx.openToolRunId = ctx.next.messages[ctx.next.messages.length - 1]?.id ?? null;
      }
    } else {
      // Open a fresh card at 1.
      bridge.pushMessage(MessageKind.ToolRun, payload);
      ctx.next = appendMessage(ctx.next, 'tool_run', payload);
      ctx.openToolRunId = ctx.next.messages[ctx.next.messages.length - 1]?.id ?? null;
      ctx.lastRingRowIsToolRun = true;
    }
  };

  const handleToolEvent = (ev: AgentStreamEvent) => {
    if (ev.type !== 'tool_start' && ev.type !== 'tool_result') return;
    // Live grouping predicate (#433): only continue the open card when the
    // last ring row is a tool-run; any non-tool row (assistant / user / error
    // / a thinking row that is last) opens a fresh group for this tool.
    if (!ctx.lastRingRowIsToolRun) resetLiveToolStreak(ctx);
    closeAssistantSegment();
    closeThinkingSegment(bridge, ctx);
    const grows =
      ev.type === 'tool_start' || !hasRunningTool(ctx.toolRunGroup, ev.name);
    if (grows && toolRunIsFull(ctx.toolRunGroup)) {
      // Group-full roll: the open card already holds TOOL_RUN_ITEMS_MAX. The
      // next tool opens a FRESH card at 1 — never grows the just-pushed full
      // card (that card is already the painted live row + its session row).
      resetLiveToolStreak(ctx);
    }
    if (ev.type === 'tool_start') {
      addToolStart(ctx.toolRunGroup, ev.name, ev.id);
    } else {
      addToolResult(
        ctx.toolRunGroup,
        ev.name,
        ev.ok,
        ctx.truncateToolTraceSummary(ev.summary),
        ev.preview,
        ev.id,
      );
      // Phase 2 (#465): a successful `change_dir` is the durable-live-cwd
      // signal. Only a confirmed success records it; anything else leaves the
      // prior value untouched. The cwd is read from the TYPED
      // `ev.changeDirCwd` field (from the raw, untruncated tool result) — NOT
      // from the truncated display `summary` (adversarial review #470 Major).
      if (ev.name === 'change_dir' && ev.ok) {
        ctx.liveCwd = ctx.recordLiveCwd(ctx.liveCwd, ev.changeDirCwd);
        // Phase 2 (#627 / #625): live cwd mutation mid-turn — apply the
        // confirmed cwd to the session and repaint the status bar immediately,
        // without waiting for `done`.
        if (ev.changeDirCwd !== undefined) {
          const cd = normalizeSessionCwd(ev.changeDirCwd);
          if (cd !== undefined) {
            ctx.next = { ...ctx.next, cwd: cd };
            ctx.foldStatusSlots(bridge, ctx.next);
            ctx.patchSession(ctx.next);
          }
        }
      }
      // Phase 2 (#627 / #625): live sandbox bind switch mid-turn. A
      // successful `meta_sandbox_switch` carries the typed target id; apply
      // it to the session, repaint the sandbox + git slots, and persist the
      // patched snapshot immediately — the switch envelope write is already
      // done server-side; this mirrors it on the host.
      if (ev.name === 'meta_sandbox_switch' && ev.ok && ev.activeSandboxId) {
        const id = ev.activeSandboxId;
        if (isRedisSafeOpaqueId(id)) {
          ctx.next = { ...ctx.next, activeSandboxId: id };
          ctx.foldStatusSlots(bridge, ctx.next);
          void ctx.refreshGitStatusSlot(bridge, ctx.next, ctx.signal);
          ctx.patchSession(ctx.next);
        }
      }
      // Phase 2 (#627 / #625): git refresh on any successful exec — no
      // session mutation, no onSessionPatch. Fail-soft; server rate-limited.
      if (ev.name === 'exec' && ev.ok) {
        void ctx.refreshGitStatusSlot(bridge, ctx.next, ctx.signal);
      }
    }
    // Paint now — the operator sees `N tools called` on THIS event.
    livePaintToolRun();
    ctx.lastUiKind = 'tool_run';
  };

  // plan #813: every parsed SSE frame advances this-heap C (including
  // skipped-by-dedup). One producer write = one getReadable index.
  return async (ev: AgentStreamEvent) => {
    ctx.heapC = bumpStreamCursor(ctx.heapC);
    ctx.next = { ...ctx.next, turnStreamCursor: ctx.heapC };
    // Fail-closed retry gate (plan #759 adversarial-review Major): any event
    // that PAINTS the ring past the user line arms `streamPainted`, so a
    // retryable-looking failure after it becomes permanent single-attempt
    // (never replay tools/duplicate bubbles onto the same ring).
    if (
      ev.type === 'tool_start' ||
      ev.type === 'tool_result' ||
      ev.type === 'reasoning_delta' ||
      ev.type === 'text_delta' ||
      ev.type === 'skill_attached'
    ) {
      ctx.streamPainted = true;
    }
    if (ev.type === 'tool_start' || ev.type === 'tool_result') {
      if (ev.type === 'tool_start') {
        ctx.replayedStarts[ev.name] = (ctx.replayedStarts[ev.name] ?? 0) + 1;
        if (
          shouldSkipToolStart({
            enabled: ctx.dedup,
            hydrated: ctx.hydratedTools,
            name: ev.name,
            replayedStartsOfName: ctx.replayedStarts[ev.name] ?? 1,
            ...(ev.id ? { callId: ev.id } : {}),
          })
        ) {
          return;
        }
      } else {
        ctx.replayedResults[ev.name] = (ctx.replayedResults[ev.name] ?? 0) + 1;
        if (
          shouldSkipToolResult({
            enabled: ctx.dedup,
            hydrated: ctx.hydratedTools,
            name: ev.name,
            replayedResultsOfName: ctx.replayedResults[ev.name] ?? 1,
            ...(ev.id ? { callId: ev.id } : {}),
          })
        ) {
          return;
        }
      }
      handleToolEvent(ev);
      return;
    }
    if (ev.type === 'reasoning_delta') {
      // Thinking is never in Blob — never skip, even on cold attach.
      growThinking(ev.text);
      return;
    }
    if (ev.type === 'text_delta') {
      const d = textDeltaDedup({
        enabled: ctx.dedup,
        hydratedAssistant: ctx.hydratedAssistant,
        replayedBefore: ctx.assistantAcc,
        chunk: ev.text,
      });
      if (d.action === 'skip') {
        ctx.assistantAcc += ev.text;
        // Hydrated this-run assistant already on the ring — do not
        // finalize-push a duplicate at `done`.
        if (ctx.hydratedAssistant) ctx.assistantStarted = true;
        return;
      }
      if (d.action === 'grow-suffix') {
        if (!ctx.assistantSegmentOpen && ctx.lastUiKind === 'assistant') {
          ctx.assistantSegmentOpen = true;
          ctx.assistantStarted = true;
          const last = ctx.next.messages[ctx.next.messages.length - 1];
          ctx.assistantSegment =
            last?.role === 'assistant' ? last.text : ctx.hydratedAssistant;
        }
        ctx.assistantAcc = ctx.hydratedAssistant;
        growAssistant(d.chunk);
        ctx.hydratedAssistant = ctx.assistantAcc;
        return;
      }
      growAssistant(ev.text);
      return;
    }
    if (ev.type === 'skill_attached') {
      if (ctx.dedup && skillAlreadyHydrated(ctx.next.messages, ev)) {
        if (Array.isArray(ev.attachedSlugs)) {
          ctx.next = { ...ctx.next, attachedSlugs: [...ev.attachedSlugs] };
        }
        return;
      }
      // Server sends skill_attached events at the START of the turn (before
      // the model). Push the display-only row live; it is a non-tool
      // separator for the tool-run predicate.
      ctx.lastRingRowIsToolRun = false;
      ctx.lastUiKind = 'assistant';
      ctx.next = ctx.pushSkillRow(bridge, ctx.next, ev);
      // Phase 2 (#517 / adversarial-review Blocker + "fold-before-persist
      // incl. fail/cancel"): every skill_attached event carries the SAME
      // final set, so last-writes-wins here never clears across events, and
      // it is applied BEFORE the model runs — so a success, a 502, or a
      // user Stop/cancel still ends with the host persisting the sticky set
      // as `meta.attachedSkills` (omitted field = leave untouched; `[]` =
      // explicit detach-all).
      if (Array.isArray(ev.attachedSlugs)) {
        ctx.next = { ...ctx.next, attachedSlugs: [...ev.attachedSlugs] };
      }
      return;
    }
    if (ev.type === 'usage') {
      // Phase 3 (plan #628) — live provider usage mid-stream: fold the
      // context slot immediately so the operator sees token counts before
      // the turn completes. `done.usage` is the final reconcile.
      const liveUsage = sanitizeUsageSummary(ev.usage);
      if (liveUsage) {
        ctx.next = { ...ctx.next, usage: liveUsage };
        ctx.foldStatusSlots(bridge, ctx.next);
        ctx.patchSession(ctx.next);
      }
      return;
    }
    if (ev.type === 'provider') {
      const slug = sanitizeResolvedProvider(ev.provider);
      if (slug) {
        ctx.next = { ...ctx.next, resolvedProvider: slug };
        bridge.setResolvedProvider(formatResolvedProviderLabel(slug));
        ctx.patchSession(ctx.next);
      }
      return;
    }
    if (ev.type === 'done') {
      ctx.sawStreamTerminal = true;
      if (typeof ev.finishReason === 'string') {
        ctx.doneFinishReason = ev.finishReason;
      }
      closeThinkingSegment(bridge, ctx);
      finalizeAssistant(ev.text ?? ctx.assistantAcc);
      const doneSlug = sanitizeResolvedProvider(ev.resolvedProvider);
      if (doneSlug) {
        ctx.next = { ...ctx.next, resolvedProvider: doneSlug };
        applyResolvedProvider(ctx.next, bridge);
        ctx.patchSession(ctx.next);
      }
      // Absent at done does **not** clear a pin already shown this turn.
      return;
    }
    if (ev.type === 'error') {
      ctx.sawStreamTerminal = true;
      closeThinkingSegment(bridge, ctx);
      // Plan #934 (source #933): the host error path deliberately does NOT
      // finalize/flatten here. A wall-capped turn ends with SSE `error` (never
      // `done`). Durability is the worker terminal persist (reconstructed
      // prior chain + this-run merge in lib/agent/turnPersistSeam.ts) plus
      // HarnessHost adopting that worker transcript before any cloud PUT —
      // a thin local flatten PUT would LWW-clobber the worker pointer.
      // Adding a host finalize here would double-paint the handoff.
    }
  };
}
