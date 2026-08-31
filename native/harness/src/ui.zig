//! Harness product UI facade — public API for main.zig + frame() band layout.
//! Paint helpers live under `ui/*.zig` with shared state in `ui/state.zig`
//! (plan #656, source issue #652). Build id (`h:…`) detects stale wasm.
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");
const build_options = @import("build_options");
const rich = @import("rich/root.zig");
const mixed_text = @import("rich/mixed_text.zig");
const composer_text = @import("composer_text.zig");
const thinking_collapse = @import("thinking_collapse.zig");
const busy_row = @import("busy_row.zig");
const transcript_split = @import("transcript_split.zig");
const model_picker = @import("model_picker.zig");
const reasoning_picker = @import("reasoning_picker.zig");
const rect_spinner = @import("rect_spinner.zig");

const state = @import("ui/state.zig");
const metrics = @import("ui/metrics.zig");
const scroll = @import("ui/scroll.zig");
const kinds = @import("ui/kinds.zig");
const chrome = @import("ui/chrome.zig");
const toolrun = @import("ui/toolrun.zig");
const thinking = @import("ui/thinking.zig");
const chip = @import("ui/chip.zig");
const status = @import("ui/status.zig");
const line1_fit = @import("ui/line1_fit.zig");
const skill = @import("ui/skill.zig");
const composer = @import("ui/composer.zig");
const composer_history = @import("ui/composer_history.zig");
const composer_chrome = @import("ui/composer_chrome.zig");
const queue_band = @import("ui/queue_band.zig");
const keymap_dispatch = @import("ui/keymap_dispatch.zig");
const help_overlay = @import("ui/help_overlay.zig");

/// Baked at compile time (`-Dbuild-id=…`); shown in header to detect stale wasm.
pub const BUILD_ID: []const u8 = build_options.build_id;

/// Apply one arrow-key history step (plan #667). Called from the composer
/// event scan BEFORE textEntry — the step machine loads a prior user message
/// into `prompt_buf` or restores the saved draft. Pure data walk: no dvui,
/// no alloc, no bridge.zig import in the history module.
fn historyApply(dir: composer_history.Step) void {
    const n = bridge.messageCount();
    // Stack allocate a KindText view from the ring (bridge.RING_CAP).
    // Walk visible indices only (messageAt), newest-first.
    var msgs_buf: [bridge.RING_CAP]composer_history.KindText = undefined;
    var user_n: usize = 0;
    var newest: usize = 0; // ordinal counter for newest-first collection
    {
        var i: usize = 0;
        while (i < n) : (i += 1) {
            if (bridge.messageAt(i)) |m| {
                msgs_buf[i] = .{ .kind = m.kind, .text = m.text };
                if (m.kind == composer_history.USER_KIND) {
                    newest += 1;
                }
            } else {
                msgs_buf[i] = .{ .kind = 0, .text = "" };
            }
        }
        user_n = newest;
    }
    const msgs = msgs_buf[0..n];

    // Save draft on the step that ENTERS history (null → some index).
    // Subsequent walks leave the saved draft alone.
    const entering = state.history_index == null and dir == .older and user_n > 0;
    if (entering) {
        // Use the caret-positioned buffer from the current textEntry by
        // reading prompt_buf directly — this is the same buffer textEntry
        // points at, so it captures the most recent operator keystrokes.
        const draft = std.mem.sliceTo(&state.prompt_buf, 0);
        const dlen = @min(draft.len, state.history_draft_buf.len);
        if (dlen > 0) @memcpy(state.history_draft_buf[0..dlen], draft[0..dlen]);
        state.history_draft_len = dlen;

        // Record a fingerprint of the newest user row so frame() can detect
        // session hydrate (plan #667, review #686 R2).
        // Session hydrate replaces all rows → fingerprint mismatches → drop.
        // Load earlier slides the ring window, so the newest user usually
        // changes — that fingerprint will also mismatch, which is acceptable
        // because ordinals name a different ring window after sliding.
        {
            var ri: usize = n;
            while (ri > 0) {
                ri -= 1;
                if (bridge.messageAt(ri)) |m| {
                    if (m.kind == composer_history.USER_KIND) {
                        const fplen = @min(m.text.len, state.history_newest_fingerprint.len);
                        state.history_newest_fp_len = @intCast(fplen);
                        @memcpy(state.history_newest_fingerprint[0..fplen], m.text[0..fplen]);
                        break;
                    }
                }
            }
        }
    }

    const r = composer_history.step(state.history_index, user_n, dir);
    state.history_index = r.index;

    switch (r.outcome) {
        .load => {
            if (r.index) |idx| {
                if (composer_history.userTextAt(msgs, idx)) |text| {
                    const ncopy = @min(text.len, state.prompt_buf.len - 1);
                    @memset(&state.prompt_buf, 0);
                    if (ncopy > 0) @memcpy(state.prompt_buf[0..ncopy], text[0..ncopy]);
                    state.prompt_buf[ncopy] = 0;
                }
            }
        },
        .restore_draft => {
            _ = composer_history.restoreDraftToPrompt(
                &state.prompt_buf,
                state.history_draft_buf[0..state.history_draft_len],
            );
            state.history_draft_len = 0;
            @memset(&state.history_draft_buf, 0);
        },
        .noop => {},
    }
}

/// Plan #742 — leader command `t` seam: flip the thinking default-collapsed
/// preference. The dispatcher closes the leader after invoking this.
fn toggleThinkingDefault() void {
    state.thinking_default_collapsed = !state.thinking_default_collapsed;
}

pub fn onInit() void {
    bridge.reset();
    @memset(&state.prompt_buf, 0);
    state.want_composer_focus = true;
    state.resetTranscriptScroll();
    // `state.resetTranscriptScroll` also closes the help overlay
    // (`help_overlay_open = false`) but does NOT reset its list scroll — an
    // in-process re-init (wasm reload / host re-mount, see the comment below)
    // would otherwise leave `ctx_scroll` mid-table, so the next open resumes
    // mid-list (review #783 round-4 Nit L1). Reset the overlay surface here,
    // the authoritative re-init site; `state.zig` stays free of ui paint imports.
    help_overlay.resetScroll();
    rich.clearCache();
    // Reset the previous-frame hug to idle: an in-process re-init (wasm reload
    // / host re-mount) must not keep a stale multi-line 124 px band until the
    // next wrap sample (adversarial review #584 Round 4 Minor L8).
    state.composer_last_h = metrics.COMPOSER_IDLE_CHROME_H;
    transcript_split.reset();
}

pub fn onDeinit() void {}

pub fn frame() !void {
    const life = bridge.getLifecycle();
    var busy = life == .busy;

    // Full-bleed root. Children that use Options.rect do not report min-size up
    // the tree (WidgetData.minSizeReportToParent) — required so tall transcript
    // content cannot push the composer off-canvas.
    var root = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .both,
        .background = true,
        .style = .window,
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_text,
        .padding = .all(0),
        .border = .all(0),
    });
    defer root.deinit();

    // Viewport in parent content coords (IMGUI: recompute every frame).
    var avail = root.data().contentRect().justSize();
    if (avail.h < 1 or avail.w < 1) {
        const wr = dvui.windowRect();
        avail = .{ .x = 0, .y = 0, .w = @max(1, wr.w), .h = @max(1, wr.h) };
    }

    // Status bar is absolute-rect at the very bottom (always-mounted, fixed 64 px).
    // Transcript + composer use absolute rects — neither participates in root flex,
    // so the scrollArea's `.auto` bar cannot publish virtual content height as the
    // root's min-size (dvui ScrollContainerWidget.deinit overwrites min_size.h with
    // full virtual content — adversarial review #584 Blocker L1).
    // Composer height is dynamic: previous-frame measured via composer_last_h,
    // clamped to [IDLE, MAX], so the band hugs the field at idle (~44 px) and
    // grows up as lines wrap (adversarial review #584 Round 2 Major L1+L9).
    const composer_h = @max(metrics.COMPOSER_IDLE_CHROME_H, @min(state.composer_last_h, metrics.COMPOSER_MAX_CHROME_H));
    const queue_band_h = @max(0, state.prev_queue_band_h);
    const status_y = avail.h - metrics.STATUS_BAR_H;
    const composer_y = status_y - composer_h;
    const queue_band_y = composer_y - queue_band_h;
    const scroll_y: f32 = 0;
    const scroll_h: f32 = @max(metrics.SCROLL_FLOOR_H, queue_band_y - scroll_y);
    // Read pane width *before* paint so a same-frame toggle cannot desync the
    // rail rect from the scrollArea x (IMGUI: click takes effect next frame).
    const pane_w = transcript_split.paneWidth();
    transcript_split.paint(scroll_y, scroll_h);

    // ── Transcript band (rail + scrollArea, sibling Options.rect) ──────────
    // Rail is a sibling absolute rect in this same scroll_y/scroll_h slice.
    // The scrollArea keeps its own Options.rect (x = pane_w) so the `.auto`
    // bar cannot publish virtual content height into the root flex.
    // (Header band removed — plan #570 merges its content into the two-line status bar)
    // Sticky last-user-message chip (plan #645): when visible from the previous
    // frame, the chip strip occupies TOUCH_H px above the scroll area. The
    // scroll area's y offset moves down and its height shrinks by the same
    // amount so content doesn't overlap. One-frame settle (same pattern as
    // composer_last_h).
    const chip_h: f32 = if (state.prev_chip_visible) metrics.TOUCH_H else 0;
    const scroll_h_chip: f32 = @max(metrics.SCROLL_FLOOR_H, scroll_h - chip_h);

    // Paint the chip strip above the scroll area when visible.
    if (state.prev_chip_visible) {
        if (state.last_user_slot) |slot| {
            chip.paintLastUserChip(@src(), slot, scroll_y, pane_w, avail);
        }
    }

    const near_before = scroll.isNearBottom(&state.transcript_scroll);
    const prev_msg = state.last_msg_count;
    const prev_shown = state.last_shown_count;
    const n = bridge.messageCount();
    const shown = n + @as(usize, if (busy) 1 else 0);

    // #424 — track lifecycle transitions so committed (completed-turn) thinking
    // collapses at turn end (busy -> ready/err) and the active Busy turn stays
    // fully expanded. Lifecycle enum values mirror bridge.Lifecycle 1:1. The busy
    // start is captured as the *physical ring head* (the slot the turn begins
    // appending at), not a message count, so membership survives saturation/wrap.
    {
        const cur_lc: thinking_collapse.Lifecycle = @enumFromInt(@intFromEnum(life));
        const prev_lc = state.prev_lifecycle;
        state.thinking_collapse_state.onLifecycleTransition(prev_lc, cur_lc, bridge.messageHead());
        state.prev_lifecycle = cur_lc;
        const editing = state.queue_editing_index != null;
        // Trigger B: a queue edit just closed this frame. The predicate needs
        // Wasm ui state only to KNOW it closed; capture the raw latch BEFORE
        // clearing, then fold it into the single host-testable seam.
        const edit_closed = state.queue_closed_edit;
        state.queue_closed_edit = false;
        // Protocol v19 promote gate (plan #760): the host arms a one-shot scalar
        // on every terminal — true on a SUCCESSFUL Ready (auto-promote stays,
        // unchanged), false on Stop / Esc / error / timeout / validation Ready.
        // `bridge.shouldAutoPromote` is the host-unit-testable seam that folds
        // BOTH triggers — the turn-ended edge (prev busy → cur ready) and the
        // edit-closed trigger B — under the same `!editing && allowed` guards
        // (adversarial #763 L6 round 2: the old call site ORed trigger B in as
        // `trigger_b and !editing and allowed`, a duplicated-guard OR that this
        // predicate now owns). `err` is NOT a promotable terminal, so a failed
        // turn can never drain the queue. When the gate is false this block can
        // never pop a queued head; only an explicit idle ▶ / Ctrl+Enter with an
        // empty composer + non-empty queue promotes. Both triggers pass the LIVE
        // edit lock into `tryPromoteQueued` so nothing drains mid-edit.
        const auto_promote = bridge.shouldAutoPromote(
            @enumFromInt(@intFromEnum(prev_lc)),
            @enumFromInt(@intFromEnum(cur_lc)),
            editing,
            bridge.hasQueuePromoteAllowed(),
            edit_closed,
        );
        if (auto_promote) {
            if (bridge.tryPromoteQueued(editing)) {
                busy = true;
            }
        }
    }
    var user_scroll: dvui.Point = .{};
    {
        var scroll_area = dvui.scrollArea(@src(), .{
            .scroll_info = &state.transcript_scroll,
            .vertical_bar = .auto,
            .user_scroll = &user_scroll,
        }, .{
            .rect = .{ .x = pane_w, .y = scroll_y + chip_h, .w = @max(0, avail.w - pane_w), .h = scroll_h_chip },
            .background = true,
            .color_fill = palette.teal_bg,
            .padding = .all(0),
            .border = .all(0),
            .corners = .{ .tl = .square, .tr = .square, .br = .square, .bl = .square },
            .min_size_content = .{ .w = 120, .h = scroll_h_chip },
            .max_size_content = .height(scroll_h_chip),
        });
        defer scroll_area.deinit();

        var body = dvui.box(@src(), .{ .dir = .vertical }, .{
            .expand = .horizontal,
        });
        defer body.deinit();

        // Protocol v6: host sets can_load_earlier when SessionStore has older turns.
        if (bridge.canLoadEarlier()) {
            if (dvui.button(@src(), "Load earlier", .{}, .{
                .expand = .horizontal,
                .style = .content,
                .min_size_content = .{ .w = 120, .h = metrics.TOUCH_H - 4 },
                .corners = .round(6),
                .color_fill = palette.teal_bg,
                .color_text = palette.teal_accent,
                .color_border = palette.teal_border,
                .margin = .{ .x = 0, .y = 0, .w = 0, .h = 8 },
                .id_extra = 0xffff_fffd,
            })) {
                if (!busy) bridge.queueLoadEarlierFromUi();
            }
        }

        if (n == 0) {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .color_text = palette.teal_muted,
            });
            if (bridge.modelCatalogCount() == 0) {
                tl.addText(
                    "No models available\n\nAsk a tenant admin to grant you an inference key,\nor wait for the host catalog to load.\n",
                    .{},
                );
            } else if (bridge.modelCatalogCount() == 1) {
                tl.addText(
                    "Start a conversation\n\nType below, then Ctrl+Enter or Send.\n",
                    .{},
                );
            } else {
                tl.addText(
                    "Start a conversation\n\nType below, then Ctrl+Enter or Send.\nPick a model in the status bar.\n",
                    .{},
                );
            }
            tl.deinit();
        } else {
            // Paint entire in-ring transcript (ring capacity 2048 — bridge.zig
            // MAX_MSG, which is private). No paint-cap / earlier hint. Empty/
            // blank assistant rows are omitted at paint (issue #324) — rule
            // lives in composer_text.zig.
            var i: usize = 0;
            while (i < n) : (i += 1) {
                if (bridge.messageAt(i)) |m| {
                    // Skip empty/blank assistant bands at paint (issue #324).
                    // The host opens a transient zero-visible-text assistant slot
                    // during multi-tool turns that would otherwise render as a
                    // full blank card ("stuck" look). Ring data is untouched —
                    // skip at paint only, so Copy/update_last/id_extra still key
                    // off ring index `i`. System/error rows and tool traces stay
                    // visible, and the busy row ("Waiting for model…") still shows.
                    if (composer_text.shouldOmitMessageAtPaint(m.kind, m.text)) {
                        continue;
                    }
                    const is_err = m.kind == 4;
                    var row = dvui.box(@src(), .{ .dir = .vertical }, .{
                        .expand = .horizontal,
                        .id_extra = i,
                        .background = kinds.kindFill(m.kind) != null,
                        .color_fill = kinds.kindFill(m.kind),
                        .color_border = if (is_err) palette.ember_border else palette.teal_border,
                        .padding = .{ .x = 8, .y = 6, .w = 8, .h = 6 },
                        .margin = .{ .x = 0, .y = 0, .w = 0, .h = 4 },
                        .style = if (is_err) .err else .content,
                    });
                    defer row.deinit();

                    // Kind label + Copy (message source → system clipboard).
                    // Tool-run (kind 6) rows are headerless (parent E): no `tools`
                    // band — the copy affordance lives on the L0 header row inside
                    // paintToolRun. Thinking (kind 5) rows are also headerless
                    // (#424): the `Thinking` expander + Copy + preview live in
                    // paintThinking, and the active/live turn keeps full GFM below.
                    // id_extra: label i*2; Copy i*%1024+2 (plain +1).
                    if (m.kind != rich.KIND_TOOL and m.kind != rich.KIND_THINKING and m.kind != rich.KIND_SKILL) {
                        var kind_row = dvui.box(@src(), .{ .dir = .horizontal }, .{
                            .expand = .horizontal,
                            .id_extra = i,
                        });
                        defer kind_row.deinit();

                        {
                            var tl = dvui.textLayout(@src(), .{}, .{
                                .expand = .horizontal,
                                .id_extra = i * 2,
                                .color_text = kinds.kindTextColor(m.kind),
                                .font = .theme(.heading),
                                .gravity_y = 0.5,
                            });
                            tl.format("{s}", .{kinds.kindLabel(m.kind)}, .{});
                            tl.deinit();
                        }
                        if (m.text.len > 0) {
                            if (dvui.button(@src(), "📋", .{}, .{
                                .gravity_y = 0.5,
                                .style = .content,
                                .id_extra = i *% 1024 + 2,
                                .min_size_content = .{ .w = 22, .h = 22 },
                                .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
                                .font = chrome.chromeCopyFont(),
                                .corners = .round(5),
                                .color_fill = palette.teal_bg,
                                .color_text = palette.teal_accent,
                                .color_border = palette.teal_border,
                                .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                            })) {
                                // Same-frame write only — do not retain ring slices.
                                dvui.clipboardTextSet(m.text);
                            }
                        }
                    }
                    {
                        // #424: thinking (kind 5) rows route through paintThinking,
                        // which renders the compact expandable control or, for the
                        // active busy turn / operator-open rows, the full GFM body.
                        if (m.kind == rich.KIND_THINKING) {
                            thinking.paintThinking(@src(), i, m.text, bridge.messageSlotAt(i), bridge.messageRevisionAt(i));
                        } else if (rich.shouldPaintMarkdown(m.kind)) {
                            // #424: for non-thinking markdown kinds, defer to the
                            // generic slot-keyed painter below (unchanged).
                            rich.paintMessageBody(@src(), m.kind, m.text, .{
                                .msg_index = i,
                                .slot = bridge.messageSlotAt(i),
                                .revision = bridge.messageRevisionAt(i),
                            });
                        } else if (m.kind == rich.KIND_SKILL) {
                            // Protocol v12 (kind 7): display-only `Skill attached:
                            // <slug>` row. Headerless, compact, muted TEAL — shows
                            // only the skill NAME, never a skill body (bodies stay
                            // server-side in the model's system context).
                            skill.paintSkillAttached(@src(), i, m.text);
                        } else if (m.kind == rich.KIND_TOOL) {
                            if (!toolrun.paintToolRun(@src(), i, m.text, bridge.messageSlotAt(i), bridge.messageRevisionAt(i))) {
                                // Fail-open (plan #345): unknown/old tool-run
                                // payload decodes to nothing → render raw text.
                                var tl = dvui.textLayout(@src(), .{}, .{
                                    .expand = .horizontal,
                                    .id_extra = i *% 1024 + 1,
                                    .color_text = palette.teal_text,
                                    .font = .theme(.body),
                                });
                                mixed_text.addTextMixed(tl, m.text, .theme(.body), .{
                                    .color_text = palette.teal_text,
                                });
                                tl.deinit();
                                // Keep the Copy affordance on a fail-open tool row
                                // too — headerless chrome moved Copy off the kind
                                // band, which is skipped for tool-run kinds.
                                if (dvui.button(@src(), "📋", .{}, .{
                                    .gravity_y = 0.5,
                                    .style = .content,
                                    .id_extra = i *% 1024 + 2,
                                    .min_size_content = .{ .w = 22, .h = 22 },
                                    .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
                                    .font = chrome.chromeCopyFont(),
                                    .corners = .round(5),
                                    .color_fill = palette.teal_bg,
                                    .color_text = palette.teal_accent,
                                    .color_border = palette.teal_border,
                                    .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                                })) {
                                    dvui.clipboardTextSet(chrome.toolRunClipboard(m.text));
                                }
                            }
                        } else {
                            var tl = dvui.textLayout(@src(), .{}, .{
                                .expand = .horizontal,
                                .id_extra = i *% 1024 + 1,
                                .color_text = if (is_err) palette.ember_text else palette.teal_text,
                                .font = .theme(.body),
                            });
                            mixed_text.addTextMixed(tl, m.text, .theme(.body), .{
                                .color_text = if (is_err) palette.ember_text else palette.teal_text,
                            });
                            tl.deinit();
                        }
                    }
                    // Per-message y-tracking for the sticky last-user-message chip
                    // (plan #645). Capture the content-local y-offset after the row
                    // is fully laid out but before deinit fires (data() is still
                    // valid). Keyed by physical ring slot so ring wrap can never
                    // alias entries across different messages.
                    if (bridge.messageSlotAt(i)) |slot_val| {
                        const cr = row.data().contentRect();
                        state.msg_content_y[slot_val] = cr.y;
                        if (m.kind == @intFromEnum(bridge.MessageKind.user)) {
                            state.last_user_slot = slot_val;
                        }
                    }
                }
            }
        }

        if (busy) {
            // Busy row (plan #574): the 2×4 WARM spinner sits LEFT of
            // "Waiting for model…" on the same line. Painted by the standalone
            // `busy_row` module (extracted so the host dvui testing-backend test
            // `busy_row_layout.test.zig` runs the exact same paint — PR #576
            // Blocker L6). The spinner's phase scalar comes from the host 10 Hz
            // tick (`inv_set_busy_tick`); the v14 ` · mm:ss` clock from
            // `bridge.turnElapsed()` — both passed in, no wasm/global dependency.
            busy_row.paintBusyRow(bridge.busyTick(), bridge.turnElapsed());
        }
    }

    // Conditional stick-to-bottom (plan #135 / #131 / #251).
    // Count changes cover pushMessage; content_grew covers inv_update_last_message
    // stream growth (thinking/assistant) where msg_count is unchanged.
    const max_y = state.transcript_scroll.scrollMax(.vertical);
    const content_grew = max_y > state.last_scroll_max_y + metrics.CONTENT_GREW_EPS;
    const count_changed = shown != prev_shown;

    if (n < prev_msg) {
        // Ring cleared only (count->0). No partial-truncate path: bridge's
        // msg_count drops via inv_clear_messages (F5/New/switch) or
        // inv_clear_ring (live-session surgical hydrate).
        // decreases it — so (n == 0) below is exactly the clear case. Drop the
        // parse cache (generation bump) and reset tool-run expand state so a
        // fresh window starts collapsed.
        if (n == 0) rich.clearCache();
        state.clearToolRunOpenState();
        state.clearThinkingOpenState();
        state.thinking_collapse_state.reset();
        state.transcript_scroll.velocity = .{ .x = 0, .y = 0 };
        scroll.scrollToBottom(&state.transcript_scroll);
        // Clear chip state — no user messages remain (plan #645).
        @memset(&state.msg_content_y, 0);
        state.last_user_slot = null;
        state.prev_chip_visible = false;
        // Clear queue editing state — otherwise an edit open during
        // New/Clear or a session switch ghosts a band and blocks promote
        // until an unmarked Escape (adversarial review #666 Major L1).
        queue_band.resetQueueEditState();
        // Close the help overlay + disarm the leader (plan #741) — a New /
        // Clear / session hydrate refreshes the surface; a staled overlay or
        // armed leader would ghost chrome. Reset the list to the top too: a
        // mid-table `ctx_scroll` offset must not survive a reopen (review #783
        // round-3 Minor L1 — New/Clear previously skipped the reset that
        // Esc/backdrop help_close already applied).
        state.help_overlay_open = false;
        state.leader_armed = false;
        help_overlay.resetScroll();
        // Plan #742 — a fresh surface resets the thinking preference to its
        // collapsed-default (same reset site as help_overlay_open / leader_armed).
        state.thinking_default_collapsed = true;
        // Drop composer arrow-key history state (plan #667) — a New /
        // Clear / session hydrate drops the ring, so ordinals are stale.
        // Only restore the saved draft when actually in history (#686 R6):
        // a live draft in prompt_buf is operator content and must survive
        // ring shrink (New / Clear / hydrate-to-shorter).
        if (state.history_index != null) {
            _ = composer_history.restoreDraftToPrompt(
                &state.prompt_buf,
                state.history_draft_buf[0..state.history_draft_len],
            );
        }
        state.history_index = null;
        state.history_draft_len = 0;
        @memset(&state.history_draft_buf, 0);
        @memset(&state.history_newest_fingerprint, 0);
        state.history_newest_fp_len = 0;
    } else if (count_changed or content_grew) {
        const newest_is_user = blk: {
            if (n == 0) break :blk false;
            if (bridge.messageAt(n - 1)) |m| break :blk m.kind == @intFromEnum(bridge.MessageKind.user);
            break :blk false;
        };
        const user_sent = newest_is_user and shown > prev_shown;
        const hydrate = (prev_msg == 0 and n > 1) or (n >= prev_msg + 3);
        const should_follow = user_sent or hydrate or prev_msg == 0 or (near_before and user_scroll.y >= 0);
        if (should_follow) {
            scroll.scrollToBottom(&state.transcript_scroll);
        } else {
            scroll.clampScrollToContent(&state.transcript_scroll);
        }
    } else {
        scroll.clampScrollToContent(&state.transcript_scroll);
    }
    // Drop queue editing latch when the FIFO is empty — the ring-length
    // proxy (n < prev_msg) misses hydrate-to-same-or-longer-session, where
    // clearMessages + push in one batch leaves msg_count >= prev_msg but
    // the queue FIFO is empty. Without this guard, a ghost band appears and
    // promote is blocked (plan #677 fix 2).
    if (queue_band.shouldDropEditOnEmptyQueue()) {
        queue_band.resetQueueEditState();
    }
    // Plan #777 — drop the pause latch when the FIFO empties (drain / Clear /
    // remove). With nothing to hold, a stale pause would silently block later
    // promotes (auto-promote / idle ▶). Mirrors the edit-latch guard above, so
    // goal 4 (unpause → drain by existing rules) stays intuitive even when the
    // operator never taps Resume.
    if (queue_band.shouldDropPauseOnEmptyQueue()) {
        bridge.setQueuePausedFromUi(false);
    }
    // Plan #759 / adversarial-review Major — a HOST front-insert (the give-up
    // `Continue` head) shifts every queued slot down one. An open queue-row edit
    // must follow the row it was on (bump to e+1) so blur/Ctrl+Enter saveEdit
    // targets the row being edited — not the new neighbor that slid into `e`.
    // No-op when no front-insert is pending and/or no edit is open.
    queue_band.reconcileFrontInsert();
    // Drop composer arrow-key history when the newest user row's identity
    // changed since entry (plan #667, adversarial review #686 R2).
    // This fingerprint check catches session hydrate (same-or-different-count
    // batch replace) where the newest user message is a different row than the
    // one we entered on. Load earlier changes the ring via a sliding window
    // (not a prepend), so the newest user usually changes and the fingerprint
    // WILL mismatch — dropping history. This is acceptable because ordinals
    // would name a different window after sliding. Submit already resets
    // history_index via resetHistory().
    // The n < prev_msg block above handles New / Clear / hydrate-to-shorter
    // with the same restoreDraftToPrompt helper (#686 R5).
    if (state.history_index != null and state.history_newest_fp_len > 0) {
        var fp_match = false;
        // Walk newest-first to find the current newest user row.
        var ri: usize = n;
        while (ri > 0) {
            ri -= 1;
            if (bridge.messageAt(ri)) |m| {
                if (m.kind == composer_history.USER_KIND) {
                    const fp = state.history_newest_fingerprint[0..state.history_newest_fp_len];
                    fp_match = composer_history.fingerprintMatch(fp, m.text);
                    break;
                }
            }
        }
        if (!fp_match) {
            state.history_index = null;
            _ = composer_history.restoreDraftToPrompt(
                &state.prompt_buf,
                state.history_draft_buf[0..state.history_draft_len],
            );
            state.history_draft_len = 0;
            @memset(&state.history_draft_buf, 0);
            @memset(&state.history_newest_fingerprint, 0);
            state.history_newest_fp_len = 0;
        }
    }

    // Always refresh trackers (grow, shrink, no-op) so stream deltas stay accurate.
    state.last_shown_count = shown;
    state.last_msg_count = n;
    state.last_scroll_max_y = state.transcript_scroll.scrollMax(.vertical);

    // Sticky last-user-message chip visibility for NEXT frame (plan #645).
    // Computed from this frame's final scroll state + per-message y-track array.
    // The chip appears when the last user message's top edge has scrolled above
    // the viewport with a small margin to prevent flicker at the boundary.
    // One-frame settle: this value drives next frame's rect adjustment + paint.
    state.prev_chip_visible = if (state.last_user_slot) |s| blk: {
        const msg_y = state.msg_content_y[s];
        const view_top = state.transcript_scroll.viewport.y;
        break :blk msg_y < view_top - metrics.CHIP_VISIBILITY_MARGIN;
    } else false;

    // ── Help overlay (plan #741 → #781) — modal in-canvas floatingWindow over
    // the transcript band. Painted after the transcript laid out (top). It
    // captures pointer + wheel (scrolling stays in the panel, never the
    // transcript), fills most of the band, and closes on a backdrop
    // click-outside (paint returns true → close).
    if (state.help_overlay_open) {
        // Modal subwindow sized against the FULL band (avail.w), not the leftover
        // transcript width — it fills the band minus margins regardless of the
        // left rail (plan #781 Goal 3). Esc / Ctrl+//leader still reach the keymap
        // dispatcher below (a floatingWindow only routes mouse events), so the
        // overlay toggles off exactly as before.
        if (help_overlay.paint(0, scroll_y, avail.w, scroll_h, .{
            .composer = state.queue_editing_index == null,
            .queue_editing = state.queue_editing_index != null,
            .busy = busy,
            .help_open = state.help_overlay_open,
            .leader_pending = state.leader_armed,
            .prompt_empty = state.prompt_buf[0] == 0,
            .in_history = state.history_index != null,
        })) {
            // Backdrop click-outside closes (mirror help_close: also disarm leader
            // and reset the list to the top so a reopen resumes at the top).
            state.help_overlay_open = false;
            state.leader_armed = false;
            help_overlay.resetScroll();
        }
    }

    // ── Submit queue band (absolute rect — above composer, below transcript) ──
    if (queue_band_h > 0) {
        queue_band.paint(queue_band_y, queue_band_h, avail.w);
    }
    state.prev_queue_band_h = queue_band.desiredHeight();

    // ── Composer chrome (absolute rect — hugs one line, grows up to cap) ───
    // Dynamic height: previous-frame measured via composer_last_h, clamped to
    // [COMPOSER_IDLE_CHROME_H, COMPOSER_MAX_CHROME_H]. At idle the band is ~44 px
    // (Send sits on the field baseline); multi-line paste grows the rect up to
    // 124 px over one frame settle (adversarial review #584 Round 2 Major L1+L9).
    // ── Submit / Stop action callbacks bound to the extracted chrome. ──────
    // The chrome module stays free of `composer`/`bridge`/`state` so the host
    // test can paint the real surface; these closures (frame-owned) carry the
    // submit/cancel dispatch, exactly as the old inline button handlers did.
    const on_send = struct {
        fn run(text: []const u8) void {
            composer.submitOrEnqueue(text);
            state.want_composer_focus = true;
        }
    }.run;
    const on_stop = struct {
        fn run() void {
            bridge.queueCancelFromUi();
        }
    }.run;
    // Plan #760 — idle ▶ with an EMPTY composer + non-empty queue promotes the
    // head (goal 2). Same seam as the terminal gate (`tryPromoteQueued`), so a
    // promoted head is a normal user send (pending submit → host starts a turn).
    // `busy` becomes true on the next frame once the host polls the pending
    // submit (mirrors on_send, which also doesn't mutate this frame's busy).
    // Adversarial #763 L1: pass the LIVE queue-edit lock so a mouse ▶ click while
    // a row's editor is open (queue_editing_index != null) cannot punch through
    // the edit lock and discard the unsaved buffer. `tryPromoteQueued(editing=true)`
    // → `canPromote` returns false, so Play is held exactly like the terminal gate.
    const on_promote = struct {
        fn run() void {
            _ = bridge.tryPromoteQueued(state.queue_editing_index != null);
        }
    }.run;

    var typed: []const u8 = state.prompt_buf[0..0];
    {
        // Single-row composer (plan #457): the multi-line field and ONE trailing
        // icon pack lay out horizontally, so a tall paste grows the field up to
        // COMPOSER_INPUT_MAX_H and then scrolls inside it — there is no second
        // action row to crush (#344), and no hint copy below the field. Plain
        // Enter inserts a newline; the send chord is Ctrl+Enter (Cmd+Enter on
        // mac). All key handling lives in the single dispatcher (plan #741) —
        // it marks the chord handled before the textEntry is built (inside the
        // extracted chrome), so the widget never injects a stray newline for
        // the submit stroke. Submit is requested via `state.request_submit`
        // (consumed after the chrome paint, which hands back the live prompt
        // text + measured outer height).
        keymap_dispatch.dispatch(.{ .history = &historyApply, .toggleThinkingDefault = &toggleThinkingDefault });

        // The chrome paints the field on an explicit trailing-RESERVED sub-rect
        // of width `avail.w − (TOUCH_H×n + 8)` so its reported min width (the
        // unwrapped line) can never squeeze the ▶/■ icons off-canvas (plan #737,
        // source #734). It returns the current field text + measured outer
        // height; the dynamic-hug clamp and the Enter-chord submit stay here.
        const res = composer_chrome.paintComposerChrome(.{
            .busy = busy,
            .avail_w = avail.w,
            .y = composer_y,
            .h = composer_h,
            .prompt_buf = &state.prompt_buf,
            .want_focus = &state.want_composer_focus,
            .actions = .{ .on_send = &on_send, .on_stop = &on_stop, .on_promote = &on_promote },
        });
        typed = res.typed;

        // Capture the field's natural wrapped height for next frame's dynamic
        // hug. paintComposerChrome measures it via `dvui.minSizeGet(field_id)`
        // AFTER the textEntry deinit (its children report back during deinit).
        // Convert outer→content (subtract TE_OVERHEAD = 2), then pad for the
        // chrome box, clamping to [IDLE, MAX] so the band hugs the field and
        // never collapses (adversarial review #584 Round 4 Blocker L1). If the
        // queried id has no stored size this frame (first frame), fall back to
        // the previous frame's measured height instead of collapsing.
        const outer_h = res.measured_h orelse state.composer_last_h;
        const raw_content = @max(0.0, outer_h - metrics.TE_OVERHEAD);
        const content_h = @max(metrics.TOUCH_H, @min(raw_content, metrics.COMPOSER_INPUT_MAX_H));
        state.composer_last_h = @max(metrics.COMPOSER_IDLE_CHROME_H, @min(content_h + 2 * metrics.COMPOSER_HUG_PAD, metrics.COMPOSER_MAX_CHROME_H));

        // Plan #741: the dispatcher set `request_submit` on the submit chord
        // before the textEntry was built. After the chrome paint the live prompt
        // buffer holds the final keystrokes — submit the current text.
        if (state.request_submit) {
            state.request_submit = false;
            if (typed.len > 0) {
                composer.submitOrEnqueue(typed);
                typed = state.prompt_buf[0..0];
                state.want_composer_focus = true;
            } else if (bridge.queuedCount() > 0) {
                // Plan #760 — Ctrl/Cmd+Enter with an EMPTY composer + non-empty
                // queue promotes the head (goal 2, mirroring the idle ▶ click).
                // tryPromoteQueued no-ops when the queue is empty, so goal 4
                // (empty+empty → no-op) needs no extra guard. Adversarial #763 L1:
                // honor the live queue-edit lock too — pass
                // `state.queue_editing_index != null` so an open row editor can
                // never be discarded by this chord.
                if (bridge.tryPromoteQueued(state.queue_editing_index != null)) {
                    busy = true;
                }
            }
        }
    }

    // ── Status bar (absolute bottom band — BELOW the composer, always mounted) ──
    // Two-line layout (plan #570): vertical container with identity on line 1
    // and status slots on line 2. Always mounted at fixed STATUS_BAR_H so the
    // transcript+composer stack never jumps when a sandbox attaches.
    {
        var bar = dvui.box(@src(), .{ .dir = .vertical }, .{
            .rect = .{ .x = 0, .y = status_y, .w = 0, .h = metrics.STATUS_BAR_H },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .padding = .{ .x = 10, .y = 0, .w = 10, .h = 0 },
            .min_size_content = .{ .w = 120, .h = metrics.STATUS_BAR_H },
            .id_extra = 0x61_0300,
        });
        defer bar.deinit();

        // Line 1: identity (spinner · build id · model picker · effort picker · provider).
        // Narrow viewport: drop build-id first, then ellipsize/drop provider, then
        // ellipsize effort, then ellipsize model.
        // Each line gets exactly STATUS_BAR_H/2 = 32 px so the picker trigger
        // (PICKER_TRIGGER_H = 32) fills its row without clipping line 2.
        {
            var line1 = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 120, .h = metrics.STATUS_BAR_H / 2 },
                .id_extra = 0x61_0100,
            });
            defer line1.deinit();

            // Width budget + drop/ellipsize on narrow viewport.
            // Locked order: spinner always; drop build-id first; ellipsize/drop
            // provider; ellipsize effort; ellipsize model.
            const budget = @max(0, line1.data().contentRect().w - metrics.STATUS_PACK_BUDGET_SAFETY);
            const body = (dvui.Options{}).fontGet();
            const spinner_w: f32 = rect_spinner.W; // 13 px slot; default TRAIL margin 10 px
            const build_id_text = "h:" ++ BUILD_ID;
            const build_id_text_w: f32 = body.textSize(build_id_text).w;
            const build_id_w: f32 = build_id_text_w + 8; // 8 px left margin on textLayout
            const cat_n = bridge.modelCatalogCount();
            const raw_label: []const u8 = if (cat_n == 0) "no model" else bridge.selectedModelLabel();
            var label: []const u8 = raw_label;
            var ellip_buf: [128]u8 = undefined;
            const label_text_w: f32 = if (label.len > 0) body.textSize(label).w else 0;
            // Conservative overhead: menu-trigger path (margin 8 + border 2 +
            // padding 8 + chevron ~10 + CARET_GAP 4). Same budget for both
            // trigger styles — the static path just gets a few extra px of slack.
            const trigger_overhead: f32 = 8 + 2 + 8 + 10 + 4; // = 32
            const label_gap: f32 = 8; // trigger left margin
            const build_id_gap: f32 = 8; // textLayout left margin

            const effort_n = bridge.reasoningEffortCount();
            const raw_effort: []const u8 = if (effort_n == 0) "" else bridge.selectedReasoningLabel();
            // Unset (NEVER_AUTO-only) must not look like a committed token
            // (adversarial-review #902 re-run Minor L1+L9).
            var effort_label: []const u8 = if (effort_n == 0)
                ""
            else if (raw_effort.len > 0)
                raw_effort
            else
                reasoning_picker.UNSET_LABEL;
            var effort_ellip_buf: [48]u8 = undefined;
            const effort_text_w: f32 = if (effort_label.len > 0) body.textSize(effort_label).w else 0;
            const effort_gap: f32 = 8;

            var provider_label: []const u8 = bridge.resolvedProviderLabel();
            var provider_ellip_buf: [bridge.MAX_RESOLVED_PROVIDER_LEN]u8 = undefined;
            const provider_gap: f32 = 8;
            const provider_text_w: f32 = if (provider_label.len > 0) body.textSize(provider_label).w else 0;
            const provider_w: f32 = if (provider_label.len > 0) provider_text_w + provider_gap else 0;

            const model_w: f32 = if (label.len > 0) label_text_w + trigger_overhead + label_gap else 0;
            const effort_w: f32 = if (effort_n > 0) effort_text_w + trigger_overhead + effort_gap else 0;

            const fit = line1_fit.dropLine1(
                budget,
                spinner_w,
                build_id_w + build_id_gap,
                model_w,
                effort_w,
                provider_w,
            );
            const paint_build_id = fit.paint_build_id;
            if (provider_label.len > 0) {
                if (fit.provider_max_w <= 0) {
                    provider_label = "";
                } else if (fit.provider_max_w + 0.5 < provider_w) {
                    const text_budget = @max(0, fit.provider_max_w - provider_gap);
                    provider_label = status.truncateToWidthPx(body, &provider_ellip_buf, provider_label, text_budget);
                }
            }

            var total: f32 = spinner_w;
            if (paint_build_id) total += build_id_w + build_id_gap;
            if (label.len > 0) total += label_text_w + trigger_overhead + label_gap;
            if (effort_n > 0) total += effort_text_w + trigger_overhead + effort_gap;
            if (provider_label.len > 0) total += body.textSize(provider_label).w + provider_gap;

            if (total > budget and effort_n > 0 and effort_label.len > 0) {
                var reserved: f32 = spinner_w + trigger_overhead + effort_gap;
                if (paint_build_id) reserved += build_id_w + build_id_gap;
                if (label.len > 0) reserved += label_text_w + trigger_overhead + label_gap;
                if (provider_label.len > 0) reserved += body.textSize(provider_label).w + provider_gap;
                const effort_budget = @max(0, budget - reserved);
                effort_label = status.truncateToWidthPx(body, &effort_ellip_buf, effort_label, effort_budget);
                total = spinner_w;
                if (paint_build_id) total += build_id_w + build_id_gap;
                if (label.len > 0) total += label_text_w + trigger_overhead + label_gap;
                if (effort_label.len > 0) total += body.textSize(effort_label).w + trigger_overhead + effort_gap;
                if (provider_label.len > 0) total += body.textSize(provider_label).w + provider_gap;
            }
            if (total > budget and label.len > 0) {
                var reserved: f32 = spinner_w + trigger_overhead + label_gap;
                if (paint_build_id) reserved += build_id_w + build_id_gap;
                if (effort_n > 0 and effort_label.len > 0) reserved += body.textSize(effort_label).w + trigger_overhead + effort_gap;
                if (provider_label.len > 0) reserved += body.textSize(provider_label).w + provider_gap;
                const label_budget = @max(0, budget - reserved);
                label = status.truncateToWidthPx(body, &ellip_buf, label, label_budget);
            }

            // Spinner: always painted (priority 1).
            rect_spinner.paint(@src(), .{
                .phase = if (busy) bridge.busyTick() else 0,
                .ramp = if (busy) rect_spinner.WARM_RAMP else rect_spinner.TEAL_IDLE_RAMP,
                .tag_prefix = "status-spinner",
                .id_extra = 0x61_0105,
            });
            // Build-id: dropped on narrow viewport (priority 3).
            if (paint_build_id) {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .background = false,
                    .color_text = palette.teal_muted,
                    .gravity_y = 0.5,
                    .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                });
                tl.format("h:{s}", .{BUILD_ID}, .{});
                tl.deinit();
            }
            // Model picker: ellipsized on narrow viewport (priority 2).
            {
                if (model_picker.paint(.{
                    .count = cat_n,
                    .selected = bridge.selectedModelIndex(),
                    .busy = busy,
                    .short_label = label,
                    .idAt = bridge.modelCatalogIdAt,
                })) |idx| {
                    bridge.setSelectedModel(idx);
                }
            }
            // Effort picker: hidden when Gateway published no values (plan #898).
            {
                if (reasoning_picker.paint(.{
                    .count = effort_n,
                    .selected = bridge.selectedReasoningIndex(),
                    .busy = busy,
                    .has_selection = bridge.selectedReasoningId().len > 0,
                    .short_label = effort_label,
                    .idAt = bridge.reasoningEffortIdAt,
                })) |idx| {
                    bridge.setSelectedReasoning(idx);
                }
            }
            // Resolved provider: display-only TEAL label; hidden when unset.
            if (provider_label.len > 0) {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .background = false,
                    .color_text = palette.teal_text,
                    .gravity_y = 0.5,
                    .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                });
                tl.format("{s}", .{provider_label}, .{});
                tl.deinit();
            }
        }

        // Line 2: status slots (protocol v13 store + drop order untouched).
        // Each line gets exactly STATUS_BAR_H/2 = 32 px so the two rows never
        // compete for space (plan #570 fallback, adversarial review #573 Major L9).
        {
            var line2 = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .gravity_y = 0.5,
                .min_size_content = .{ .w = 120, .h = metrics.STATUS_BAR_H / 2 },
                .id_extra = 0x61_0200,
            });
            defer line2.deinit();
            status.paintStatusSlots(life);
        }
    }
}
