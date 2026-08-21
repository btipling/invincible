//! Per-frame keymap dispatcher — plan #741.
//!
//! Runs ONCE per frame, before the composer textEntry is built (same insertion
//! point as the old inline loop), so handled chords never insert `\n`/space/
//! arrows into the field. It walks `dvui.events()` and feeds each key event to
//! the pure `keymap.match`; every `.action` / `.swallow_leader` is marked
//! handled and routed to a product seam; every `.browser` (reserved chord) is
//! left unhandled so the browser keeps it (Goal 3).
//!
//! This dispatcher OWNS all key handling — `ui.zig`, `queue_band.handleEscape`
//! and `queue_band.submitChord` no longer scan `for (dvui.events())` for keys.
//! No `for (dvui.events())` key loop lives outside this module (DoD).
//!
//! Leader window: `dvui.timer(LEADER_TIMER_ID, LEADER_WINDOW_MS*1000)` arms on
//! `Action.leader` (`.down` only); `timerDone` expires it. No host I/O, no new
//! exports — the window/timer clock is already in dvui (plan decision #2).
const std = @import("std");
const dvui = @import("dvui");
const keymap = @import("../keymap.zig");
const state = @import("state.zig");
const bridge = @import("../bridge.zig");
const queue_band = @import("queue_band.zig");
const composer_history = @import("composer_history.zig");

/// Distinct timer id for the leader window (dvui timer ids are an internal
/// namespace; a fixed value here is collision-safe vs widget ids which come
/// from `Id.extendId`).
const LEADER_TIMER_ID: dvui.Id = @enumFromInt(0x7410_0000_0000_0001);

/// Product seams that live in `ui.zig` (which imports this module) — passed in
/// to avoid an import cycle: `history` calls ui.zig's `historyApply`, and
/// `toggleThinkingDefault` flips the thinking default-collapsed preference
/// (plan #742, Leader then `t`).
pub const Handlers = struct {
    history: *const fn (composer_history.Step) void,
    toggleThinkingDefault: *const fn () void,
};

/// Convert dvui's `enums.Key` to the keymap `Key` subset.
///
/// Pure modifier / lock keys (`left_shift`/`right_shift`/`left_control`/
/// `right_control`/`left_alt`/`right_alt`/`left_command`/`right_command`,
/// `menu`, `num_lock`, `caps_lock`, `print`, `scroll_lock`, `pause` and dvui's
/// own `unknown`) return null — the dispatcher passes them through untouched
/// (Goal 3) and they NEVER disarm the leader: releasing Ctrl/Shift after
/// arming (`Ctrl+Shift+Space`) or pressing Shift again for the `?` command must
/// not kill the window.
///
/// Every OTHER unrecognized key (letters outside the subset, digits,
/// punctuation, Backspace, function keys beyond f5, navigation) maps to
/// `.unknown` and flows through `keymap.match` like any key: while a leader is
/// pending that makes it `.swallow_leader` (handled + disarmed) so it never
/// lands in the prompt; otherwise `.none` (pass-through).
fn fromDvui(code: anytype) ?keymap.Key {
    return switch (code) {
        .enter => .enter,
        .escape => .escape,
        .up => .up,
        .down => .down,
        .space => .space,
        .slash => .slash,
        .tab => .tab,
        .left => .left,
        .right => .right,
        .f5 => .f5,
        .c => .c,
        .v => .v,
        .x => .x,
        .a => .a,
        .z => .z,
        .s => .s,
        .f => .f,
        .t => .t,
        .n => .n,
        .w => .w,
        .r => .r,
        .l => .l,
        .p => .p,
        .i => .i,
        .j => .j,
        // Pure modifiers / locks — pass through, never disarm the leader.
        .left_shift, .right_shift, .left_control, .right_control, .left_alt, .right_alt, .left_command, .right_command => null,
        .menu, .num_lock, .caps_lock, .print, .scroll_lock, .pause, .unknown => null,
        // Everything else: route to the keymap so `match` can swallow it during
        // the leader window (and pass through otherwise).
        else => .unknown,
    };
}

fn keyAction(ke: anytype) keymap.KeyAction {
    return switch (ke.action) {
        .down => .down,
        .repeat => .repeat,
        .up => .up,
    };
}

fn currentCtx() keymap.Context {
    const busy = bridge.getLifecycle() == .busy;
    return .{
        // `composer` proxy: the composer is the only text input; when a
        // queue-row editor is open, queue_editing owns caret/keys. Matches the
        // old inline gating (plan decision #4).
        .composer = state.queue_editing_index == null,
        .queue_editing = state.queue_editing_index != null,
        .busy = busy,
        .help_open = state.help_overlay_open,
        .leader_pending = state.leader_armed,
        .prompt_empty = state.prompt_buf[0] == 0,
        .in_history = state.history_index != null,
    };
}

fn disarmLeader() void {
    state.leader_armed = false;
}

fn armLeader() void {
    state.leader_armed = true;
    dvui.timer(LEADER_TIMER_ID, @intCast(keymap.LEADER_WINDOW_MS * 1000));
}

/// Actions that fire on held (repeat) too — history walks (matches old ↑↓
/// repeat handling). All other actions fire once on `.down`.
fn firesOnRepeat(action: keymap.Action) bool {
    return switch (action) {
        .history_older, .history_newer => true,
        else => false,
    };
}

fn runAction(action: keymap.Action, down: bool, handlers: Handlers) void {
    switch (action) {
        .submit => {
            if (!down) return;
            // The composer textEntry hasn't been built yet this frame
            // (dispatch runs before it). Request the submit; ui.zig consumes
            // the flag after `te.deinit` and reads the live prompt buffer.
            state.request_submit = true;
        },
        .queue_save => {
            if (!down) return;
            if (state.queue_editing_index) |idx| {
                const text = std.mem.sliceTo(state.queue_edit_buf[0..], 0);
                queue_band.saveEdit(@intCast(idx), text);
            }
        },
        .history_older => {
            if (!down and !firesOnRepeat(action)) return;
            handlers.history(.older);
        },
        .history_newer => {
            if (!down and !firesOnRepeat(action)) return;
            handlers.history(.newer);
        },
        .cancel_turn => {
            if (!down) return;
            bridge.queueCancelFromUi();
        },
        .cancel_queue_edit => {
            if (!down) return;
            queue_band.cancelEditFromUi();
        },
        .help_close => {
            if (!down) return;
            state.help_overlay_open = false;
            disarmLeader();
        },
        .help_toggle => {
            if (!down) return;
            state.help_overlay_open = !state.help_overlay_open;
        },
        .help_toggle_leader => {
            if (!down) return;
            state.help_overlay_open = !state.help_overlay_open;
            disarmLeader();
        },
        .leader => {
            if (!down) return;
            armLeader();
        },
        .leader_cancel => {
            if (!down) return;
            disarmLeader();
        },
        .thinking_default_toggle => {
            if (!down) return;
            // Flip the preference and close the leader (leader command `t`).
            handlers.toggleThinkingDefault();
            disarmLeader();
        },
    }
}

/// One wire-up per frame: resolve the leader timeout, then scan every key
/// event and route it. Called from `ui.zig` `frame()` before the composer
/// textEntry is built.
pub fn dispatch(handlers: Handlers) void {
    // Expire the leader window first (timerDone true on the first frame after).
    if (state.leader_armed and dvui.timerDone(LEADER_TIMER_ID)) {
        disarmLeader();
    }

    const es = dvui.events();
    for (0..es.len) |idx| {
        const e = &es[idx];
        if (e.handled) continue;
        const ke = switch (e.evt) {
            .key => |k| k,
            else => continue,
        };

        const kcode = fromDvui(ke.code) orelse continue;
        const mods = keymap.Mods{
            .control = ke.mod.control(),
            .command = ke.mod.command(),
            .shift = ke.mod.shift(),
            .alt = ke.mod.alt(),
        };
        const act = keyAction(ke);
        const m = keymap.match(kcode, act, mods, currentCtx());

        switch (m.outcome) {
            .browser => {
                // Reserved browser chord — never marked handled. If the leader
                // was pending, disarm it (the browser still gets the key, per
                // plan test 9).
                disarmLeader();
            },
            .none => {},
            .swallow_leader => {
                // Leader pending + unmatched key: consume (no insert) + disarm.
                e.handled = true;
                disarmLeader();
            },
            .action => {
                e.handled = true;
                if (m.action) |action| {
                    runAction(action, act == .down, handlers);
                }
            },
        }
    }
}
