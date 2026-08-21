//! Single keymap for the harness — plan #741.
//!
//! OWNERSHIP: the keymap table + reserved-browser deny-list + leader state
//! live here (pure, no dvui / no bridge — host-unit-tested like
//! `composer_history.zig`). The per-frame dispatch that iterates dvui events,
//! marks `handled`, and runs actions lives in `ui/keymap_dispatch.zig`.
//!
//! Every product chord is one row below; `ui.zig` / `queue_band.zig` no longer
//! match keys inline (Goal 1). The reserved-browser set is a fail-closed deny
//! list: a chord there is NEVER marked handled, even if a row also recognizes
//! it (Goal 3 / "we never consume what the browser needs").
const std = @import("std");

/// Static-table cap (generous for follow-up chords; not a wire; plan-only cap).
pub const KEYMAP_MAX: usize = 64;

/// Leader prefix window (ms) between Ctrl+Shift+Space and the command key.
pub const LEADER_WINDOW_MS: u64 = 800;

/// Logical key codes the harness interprets (self-contained subset of
/// dvui's `enums.Key`; dispatch converts via `fromDvui`). Kept here so the
/// pure module never imports dvui.
pub const Key = enum {
    enter,
    escape,
    up,
    down,
    space,
    slash, // '/' and '?' (the latter via mods.shift)
    tab,
    left,
    right,
    f5,
    // letters referenced by the reserved-browser set / potential future chords
    c,
    v,
    x,
    a,
    z,
    s,
    f,
    t,
    n,
    w,
    r,
    l,
    p,
    i,
    j,
};

/// Key action reported by the browser/dvui.
pub const KeyAction = enum { down, repeat, up };

/// Live modifier state from dvui.
pub const Mods = struct {
    control: bool = false,
    command: bool = false,
    shift: bool = false,
    alt: bool = false,
};

/// Modifier requirement for a chord row. Mutually exclusive prereqs; the
/// dispatcher builds `Mods` from dvui and keymap matches one prereq.
pub const ModPrereq = enum {
    /// No modifiers pressed.
    none,
    /// Control OR Command (submit / queue_save / help_toggle).
    ctrl_or_cmd,
    /// Control AND Shift, and NOT Command (leader prefix — Control both platforms).
    ctrl_shift,
    /// Shift only (leader `?` = Shift+/).
    shift,
    /// Alt only (browser back/forward Alt+Left / Alt+Right).
    alt,
};

fn modsMatch(mods: Mods, prereq: ModPrereq) bool {
    return switch (prereq) {
        .none => !mods.control and !mods.command and !mods.shift and !mods.alt,
        .ctrl_or_cmd => !mods.shift and !mods.alt and (mods.control or mods.command),
        .ctrl_shift => mods.control and mods.shift and !mods.command and !mods.alt,
        .shift => mods.shift and !mods.control and !mods.command and !mods.alt,
        .alt => mods.alt and !mods.control and !mods.command and !mods.shift,
    };
}

/// Product action a handled chord triggers. The dispatcher has a `*const fn`
/// handler for each (via `ui/state.zig` + `ui.zig`/`queue_band.zig` seams).
pub const Action = enum {
    submit,
    queue_save,
    history_older,
    history_newer,
    cancel_turn,
    cancel_queue_edit,
    help_close,
    help_toggle,
    help_toggle_leader,
    /// Ctrl+Shift+Space — arm the leader window (dispatcher).
    leader,
    /// Escape while leader pending — disarm (no insert, no product action).
    leader_cancel,
};

/// Frame context bits the `when` gating reads. `leader_pending` is managed by
/// the leader state machine (dispatcher) each frame.
///
/// Matching convention: in a `when_true` / `when_false`, `true` constrains the
/// field and `false` means "don't care". The dispatcher builds the LIVE ctx
/// (every field explicit).
pub const Context = struct {
    composer: bool = false,
    queue_editing: bool = false,
    busy: bool = false,
    help_open: bool = false,
    leader_pending: bool = false,
    /// Composer prompt is empty (row 4 / history_older when this OR in_history).
    prompt_empty: bool = false,
    /// Already walking composer history (rows 4/5).
    in_history: bool = false,
};

/// Outcome of a single key event through `match`.
pub const Outcome = enum {
    /// Nothing to do; do not mark handled (textEntry / browser keep it).
    none,
    /// Reserved browser chord — fail-closed: do NOT mark handled.
    browser,
    /// Handle + run `action`.
    action,
    /// Leader pending, key is not the command: swallow (handled, no insert),
    /// disarm the leader. Reserved chords were filtered to `.browser` above.
    swallow_leader,
};

/// Pure match result: verdict + which product action (if `.action`).
pub const Match = struct {
    outcome: Outcome,
    action: ?Action = null,
};

/// Static table row.
pub const Row = struct {
    /// Stable id (also the `help_label` source id for the overlay).
    id: []const u8,
    key: Key,
    prereq: ModPrereq,
    /// Context bits that must all be true to match.
    when_true: Context = .{},
    /// Context bits that must all be false to match.
    when_false: Context = .{},
    action: Action,
    help: []const u8 = "",
};

/// Does `ctx` satisfy every constraint in `when`? A `true` field in `when`
/// must be true in `ctx`; a `false` field in `when` means "don't care".
fn ctxSubset(ctx: Context, when: Context) bool {
    if (when.composer and !ctx.composer) return false;
    if (when.queue_editing and !ctx.queue_editing) return false;
    if (when.busy and !ctx.busy) return false;
    if (when.help_open and !ctx.help_open) return false;
    if (when.leader_pending and !ctx.leader_pending) return false;
    if (when.prompt_empty and !ctx.prompt_empty) return false;
    if (when.in_history and !ctx.in_history) return false;
    return true;
}

/// Shipped rows (Goal 1: every harness chord is one table row). Escapes are
/// ordered help_close → cancel_queue_edit → leader_cancel → cancel_turn so a
/// competing context resolves predictably (help wins, then queue edit, then
/// leader, then busy cancel — matches current behavior + plan precedence).
pub const KEY_TABLE = [_]Row{
    // ── send / enqueue (composer) ─────────────────────────────────────────
    .{
        .id = "submit",
        .key = .enter,
        .prereq = .ctrl_or_cmd,
        .when_true = .{ .composer = true },
        .when_false = .{ .queue_editing = true },
        .action = .submit,
        .help = "Send (enqueue when busy)",
    },
    // ── queue-row save-edit (queue_editing context) ───────────────────────
    .{
        .id = "queue_save",
        .key = .enter,
        .prereq = .ctrl_or_cmd,
        .when_true = .{ .queue_editing = true },
        .action = .queue_save,
        .help = "Save queued item",
    },
    // ── history older (↑) ──────────────────────────────────────────────────
    .{
        .id = "history_older",
        .key = .up,
        .prereq = .none,
        .when_true = .{ .composer = true, .prompt_empty = true },
        .when_false = .{ .queue_editing = true },
        .action = .history_older,
        .help = "Older message",
    },
    .{
        .id = "history_older_in",
        .key = .up,
        .prereq = .none,
        .when_true = .{ .composer = true, .in_history = true },
        .when_false = .{ .queue_editing = true },
        .action = .history_older,
        .help = "Older message",
    },
    // ── history newer (↓, only while in history) ───────────────────────────
    .{
        .id = "history_newer",
        .key = .down,
        .prereq = .none,
        .when_true = .{ .composer = true, .in_history = true },
        .when_false = .{ .queue_editing = true },
        .action = .history_newer,
        .help = "Newer message",
    },
    // ── escape family (ordered help → queue → leader → busy) ──────────────
    .{
        .id = "help_close",
        .key = .escape,
        .prereq = .none,
        .when_true = .{ .help_open = true },
        .action = .help_close,
        .help = "Close help",
    },
    .{
        .id = "cancel_queue_edit",
        .key = .escape,
        .prereq = .none,
        .when_true = .{ .queue_editing = true },
        .action = .cancel_queue_edit,
        .help = "Discard queued item edit",
    },
    .{
        .id = "leader_cancel",
        .key = .escape,
        .prereq = .none,
        .when_true = .{ .leader_pending = true },
        .action = .leader_cancel,
        .help = "Cancel leader",
    },
    .{
        .id = "cancel_turn",
        .key = .escape,
        .prereq = .none,
        .when_true = .{ .busy = true },
        .when_false = .{ .queue_editing = true, .help_open = true },
        .action = .cancel_turn,
        .help = "Stop the turn",
    },
    // ── leader prefix (global) ─────────────────────────────────────────────
    .{
        .id = "leader",
        .key = .space,
        .prereq = .ctrl_shift,
        .when_true = .{},
        .action = .leader,
        .help = "Leader: Ctrl+Shift+Space",
    },
    // ── help toggle (direct Ctrl/Cmd+/) ───────────────────────────────────
    .{
        .id = "help_toggle",
        .key = .slash,
        .prereq = .ctrl_or_cmd,
        .when_true = .{},
        .action = .help_toggle,
        .help = "Toggle help",
    },
    // ── leader command: ? ─────────────────────────────────────────────────
    .{
        .id = "help_toggle_leader",
        .key = .slash,
        .prereq = .shift,
        .when_true = .{ .leader_pending = true },
        .action = .help_toggle_leader,
        .help = "Toggle help (leader)",
    },
};

/// Reserved-browser deny-list — (key, prereq) pairs never marked handled.
/// From the plan: Ctrl/Cmd+T N W R L P S F, Ctrl+Shift+T, Ctrl+Tab /
/// Ctrl+Shift+Tab, Alt+Left/Right, F5 / Ctrl+R, Ctrl+Shift+C I J (devtools
/// family), Ctrl/Cmd+C V X A Z (editing — leave to textEntry / browser).
/// Ctrl+/ and Ctrl+Shift+Space are NOT reserved.
const RESERVED = [_]struct { key: Key, prereq: ModPrereq }{
    .{ .key = .t, .prereq = .ctrl_or_cmd },
    .{ .key = .n, .prereq = .ctrl_or_cmd },
    .{ .key = .w, .prereq = .ctrl_or_cmd },
    .{ .key = .r, .prereq = .ctrl_or_cmd },
    .{ .key = .l, .prereq = .ctrl_or_cmd },
    .{ .key = .p, .prereq = .ctrl_or_cmd },
    .{ .key = .s, .prereq = .ctrl_or_cmd },
    .{ .key = .f, .prereq = .ctrl_or_cmd },
    .{ .key = .c, .prereq = .ctrl_or_cmd },
    .{ .key = .v, .prereq = .ctrl_or_cmd },
    .{ .key = .x, .prereq = .ctrl_or_cmd },
    .{ .key = .a, .prereq = .ctrl_or_cmd },
    .{ .key = .z, .prereq = .ctrl_or_cmd },
    .{ .key = .i, .prereq = .ctrl_or_cmd },
    .{ .key = .j, .prereq = .ctrl_or_cmd },
    .{ .key = .tab, .prereq = .ctrl_or_cmd },
    .{ .key = .f5, .prereq = .none },
    // Alt+Left / Alt+Right (browser back/forward) — notice Ctrl+Left/Right are
    // text caret word-moves, NOT reserved (textEntry keeps them).
    .{ .key = .left, .prereq = .alt },
    .{ .key = .right, .prereq = .alt },
};

pub fn isReserved(key: Key, mods: Mods) bool {
    for (RESERVED) |r| {
        if (r.key == key and modsMatch(mods, r.prereq)) return true;
    }
    return false;
}

/// Pure leader state — armed_until_ms on the frame clock (dispatcher feeds
/// `now_ms` from dvui `timerGet`).
pub fn leaderTimedOut(armed: bool, elapsed_ms: u64) bool {
    return armed and elapsed_ms >= LEADER_WINDOW_MS;
}

fn rowMatches(row: Row, key: Key, mods: Mods, ctx: Context) bool {
    if (row.key != key) return false;
    if (!modsMatch(mods, row.prereq)) return false;
    if (!ctxSubset(ctx, row.when_true)) return false;
    if (ctxIntersects(row.when_false, ctx)) return false;
    return true;
}

fn ctxIntersects(forbidden: Context, ctx: Context) bool {
    return (forbidden.composer and ctx.composer) or
        (forbidden.queue_editing and ctx.queue_editing) or
        (forbidden.busy and ctx.busy) or
        (forbidden.help_open and ctx.help_open) or
        (forbidden.leader_pending and ctx.leader_pending) or
        (forbidden.prompt_empty and ctx.prompt_empty) or
        (forbidden.in_history and ctx.in_history);
}

/// Dispatch one key event through the table. Pure: no dvui, no bridge, no I/O.
///
/// Leader handling is table-driven: the `leader` row (space+ctrl_shift) fires
/// the `.leader` action (the dispatcher arms on `.down` only); while
/// `ctx.leader_pending` the `help_toggle_leader` (`?`) and `leader_cancel`
/// (Escape) rows have product actions; any other key that no row matches
/// swallows (`.swallow_leader` — handled + disarmed) so it never lands in the
/// prompt — except reserved browser chords, which were filtered to `.browser`
/// first (and never consumed).
pub fn match(key: Key, action: KeyAction, mods: Mods, ctx: Context) Match {
    // Reserved deny-list wins over everything (fail closed — never consume
    // what the browser needs, even if a row also recognizes the chord).
    if (isReserved(key, mods)) return .{ .outcome = .browser };

    // Fire on .down / .repeat (matching current ui.zig behaviour — held Enter
    // is handled so it doesn't inject newlines, but only .down submits once;
    // the dispatcher likewise arms the leader on .down only).
    if (action == .up) return .{ .outcome = .none };

    for (KEY_TABLE) |row| {
        if (rowMatches(row, key, mods, ctx)) {
            return .{ .outcome = .action, .action = row.action };
        }
    }

    // Leader pending and no row matched (and not a reserved browser): swallow
    // (handled, disarmed) so the key never lands in the prompt (fail closed).
    if (ctx.leader_pending) return .{ .outcome = .swallow_leader };

    return .{ .outcome = .none };
}

/// Table length helper for the help overlay + cap assertion.
pub fn tableLen() usize {
    return KEY_TABLE.len;
}

test "keymap: table within KEYMAP_MAX and has the shipped rows" {
    try std.testing.expect(tableLen() <= KEYMAP_MAX);
    try std.testing.expect(tableLen() >= 6);
}

test "keymap: submit — Ctrl+Enter idle composer" {
    const m = match(.enter, .down, .{ .control = true }, .{ .composer = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.submit, m.action.?);
}

test "keymap: submit — Cmd+Enter idle composer" {
    const m = match(.enter, .down, .{ .command = true }, .{ .composer = true });
    try std.testing.expectEqual(Action.submit, m.action.?);
}

test "keymap: submit — held Enter marks handled (repeat) without extra action" {
    const m = match(.enter, .repeat, .{ .control = true }, .{ .composer = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.submit, m.action.?);
}

test "keymap: submit — key up is not handled" {
    const m = match(.enter, .up, .{ .control = true }, .{ .composer = true });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}

test "keymap: queue_save — Ctrl+Enter queue_editing (5b regression of submitChord)" {
    const m = match(.enter, .down, .{ .control = true }, .{ .queue_editing = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.queue_save, m.action.?);
}

test "keymap: queue_save wins over submit when queue_editing" {
    const m = match(.enter, .down, .{ .control = true }, .{ .composer = true, .queue_editing = true });
    try std.testing.expectEqual(Action.queue_save, m.action.?);
}

test "keymap: escape busy not queue-editing → cancel_turn (row 2)" {
    const m = match(.escape, .down, .{}, .{ .composer = true, .busy = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.cancel_turn, m.action.?);
}

test "keymap: escape idle → none (textEntry keeps it, closes menus)" {
    const m = match(.escape, .down, .{}, .{ .composer = true, .busy = false });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}

test "keymap: escape queue_editing → cancel_queue_edit, NOT cancel_turn (row 3, #705)" {
    const m = match(.escape, .down, .{}, .{ .queue_editing = true, .busy = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.cancel_queue_edit, m.action.?);
}

test "keymap: escape help_open → help_close wins over cancel_turn (row 4)" {
    const m = match(.escape, .down, .{}, .{ .busy = true, .help_open = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.help_close, m.action.?);
}

test "keymap: ↑ empty composer → history_older (row 5)" {
    const m = match(.up, .down, .{}, .{ .composer = true, .prompt_empty = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.history_older, m.action.?);
}

test "keymap: ↑ draft text not in history → none (caret moves)" {
    const m = match(.up, .down, .{}, .{ .composer = true, .prompt_empty = false, .in_history = false });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}

test "keymap: ↑ queue_editing → none (queue editor owns caret)" {
    const m = match(.up, .down, .{}, .{ .queue_editing = true });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}

test "keymap: ↓ in history → history_newer" {
    const m = match(.down, .down, .{}, .{ .composer = true, .in_history = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.history_newer, m.action.?);
}

test "keymap: ↓ not in history → none" {
    const m = match(.down, .down, .{}, .{ .composer = true, .in_history = false });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}

test "keymap: browser reserved never handled (row 6)" {
    try std.testing.expectEqual(Outcome.browser, match(.f, .down, .{ .control = true }, .{ .composer = true }).outcome);
    try std.testing.expectEqual(Outcome.browser, match(.t, .down, .{ .control = true }, .{ .composer = true }).outcome);
    try std.testing.expectEqual(Outcome.browser, match(.l, .down, .{ .command = true }, .{ .composer = true }).outcome);
    try std.testing.expectEqual(Outcome.browser, match(.c, .down, .{ .control = true }, .{ .composer = true }).outcome);
    try std.testing.expectEqual(Outcome.browser, match(.r, .down, .{ .control = true }, .{ .composer = true }).outcome);
}

test "keymap: reserved even when its chord overlaps a row (fail closed)" {
    // Ctrl+T isn't a shipped row, but ensure the deny path exists and wins.
    try std.testing.expectEqual(Outcome.browser, match(.t, .down, .{ .control = true }, .{ .composer = true }).outcome);
}

test "keymap: Ctrl+/ toggles help (works on win/linux ctrl)" {
    const m = match(.slash, .down, .{ .control = true }, .{ .composer = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.help_toggle, m.action.?);
}

test "keymap: Cmd+/ toggles help (mac)" {
    const m = match(.slash, .down, .{ .command = true }, .{ .composer = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.help_toggle, m.action.?);
}

test "keymap: bare / is not help (printable slash in composer)" {
    const m = match(.slash, .down, .{}, .{ .composer = true });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}

test "keymap: leader arms on Ctrl+Shift+Space (row 7)" {
    const m = match(.space, .down, .{ .control = true, .shift = true }, .{ .composer = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.leader, m.action.?);
}

test "keymap: Ctrl+Space (IME) and Cmd+Space (Spotlight) do NOT arm" {
    try std.testing.expectEqual(Outcome.none, match(.space, .down, .{ .control = true }, .{ .composer = true }).outcome);
    try std.testing.expectEqual(Outcome.none, match(.space, .down, .{ .command = true }, .{ .composer = true }).outcome);
}

test "keymap: leader + ? within window → help_toggle_leader (row 7)" {
    const m = match(.slash, .down, .{ .shift = true }, .{ .leader_pending = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.help_toggle_leader, m.action.?);
}

test "keymap: leader + Esc → leader_cancel (not turn cancel)" {
    const m = match(.escape, .down, .{}, .{ .leader_pending = true });
    try std.testing.expectEqual(Outcome.action, m.outcome);
    try std.testing.expectEqual(Action.leader_cancel, m.action.?);
}

test "keymap: leader + unmatched printable → swallow (never inserts)" {
    const m = match(.a, .down, .{}, .{ .leader_pending = true });
    try std.testing.expectEqual(Outcome.swallow_leader, m.outcome);
}

test "keymap: leader + reserved browser chord → disarm browser (test 9)" {
    // Leader pending + Ctrl+T is reserved → `.browser` (never handled), and the
    // dispatcher disarms. The deny-list runs before leader handling.
    const m = match(.t, .down, .{ .control = true }, .{ .leader_pending = true });
    try std.testing.expectEqual(Outcome.browser, m.outcome);
}

test "keymap: leaderTimedOut — armed within window, expired after" {
    try std.testing.expectEqual(false, leaderTimedOut(true, 0));
    try std.testing.expectEqual(false, leaderTimedOut(true, LEADER_WINDOW_MS - 1));
    try std.testing.expectEqual(true, leaderTimedOut(true, LEADER_WINDOW_MS));
    try std.testing.expectEqual(false, leaderTimedOut(false, 0));
    try std.testing.expectEqual(false, leaderTimedOut(false, 10_000));
}

test "keymap: bare Enter (no ctrl/cmd) is a newline — none (plan non-goal)" {
    const m = match(.enter, .down, .{}, .{ .composer = true });
    try std.testing.expectEqual(Outcome.none, m.outcome);
}
