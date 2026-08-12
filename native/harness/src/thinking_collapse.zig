//! Pure transcript "thinking collapse" policy (#424).
//!
//! Host-unit-tested (no dvui / wasm frame), mirroring `composer_text.zig` /
//! `ring_slot.zig` seams. The rule locked here:
//!
//!   - While the harness is **Busy**, every thinking row that belongs to the
//!     current turn (ring index >= the index where Busy began) renders the FULL
//!     monologue — the operator is still reading the active turn's chain of
//!     thought, including the live `update_last` newest slot.
//!   - When a turn **completes** (Busy -> ready/err), every committed thinking
//!     row collapses to the compact expandable control. Re-clicking a row opens
//!     it (operator set lives in `ui.zig`, in-memory only — thinking is
//!     ephemeral and never survives refresh).
//!
//! No dvui, no bridge export, no protocol change. `active_turn_start` is a ring
//! index relative to `msg_count`, so ring truncation / `Clear` just resets it.
const std = @import("std");

/// Mirrors `bridge.Lifecycle` without importing bridge (same enum values) so the
/// policy stays an isolated, host-testable module.
pub const Lifecycle = enum(u8) {
    boot = 0,
    ready = 1,
    busy = 2,
    err = 3,
};

pub const State = struct {
    /// Ring index where the current Busy turn began, or `none` when idle
    /// (ready/err/boot). Thinking rows at `index >= active_turn_start` are the
    /// active turn and stay expanded while Busy.
    active_turn_start: ?usize = null,

    /// Reset for a cleared / reloaded transcript.
    pub fn reset(self: *State) void {
        self.active_turn_start = null;
    }

    /// Record the active-turn start on a real idle->busy transition; clear it on
    /// busy->ready/err so committed thinking collapses. `msg_count` is the ring
    /// count at the transition (index base for this turn's appended rows).
    pub fn onLifecycleTransition(self: *State, prev: Lifecycle, next: Lifecycle, msg_count: usize) void {
        const was_busy = prev == .busy;
        const is_busy = next == .busy;
        if (is_busy and !was_busy) {
            self.active_turn_start = msg_count;
        } else if (was_busy and !is_busy) {
            self.active_turn_start = null;
        }
    }

    /// Whether a thinking row at ring index `i` belongs to the current Busy turn
    /// (`i >= active_turn_start`). Such rows are pinned FULL while Busy — the
    /// operator is still reading the active turn's chain of thought (including
    /// the live `update_last` newest slot) and should not be collapsed mid-turn.
    pub fn isActiveTurnFull(self: *const State, i: usize) bool {
        const start = self.active_turn_start orelse return false;
        return i >= start;
    }

    /// Whether a thinking row at ring index `i` should render the FULL monologue:
    /// True when it is part of the current Busy turn OR the operator explicitly
    /// opened it. Otherwise it renders collapsed. Operator-open rows (committed,
    /// outside the active turn) can be toggled back off; active-turn rows stay
    /// pinned full regardless of the operator set.
    pub fn shouldRenderFull(self: *const State, i: usize, operator_open: bool) bool {
        return self.isActiveTurnFull(i) or operator_open;
    }
};

test "idle->busy records active_turn_start; busy->ready clears it" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 7);
    try std.testing.expectEqual(@as(?usize, 7), s.active_turn_start);

    s.onLifecycleTransition(.busy, .ready, 11);
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start);
}

test "busy->err clears active_turn_start too" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 3);
    s.onLifecycleTransition(.busy, .err, 9);
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start);
}

test "non-busy transitions do not move active_turn_start" {
    var s: State = .{};
    // ready->ready, boot->ready: no busy edge, start stays null.
    s.onLifecycleTransition(.ready, .ready, 2);
    s.onLifecycleTransition(.boot, .ready, 3);
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start);
}

test "busy->busy keeps the original start (re-busy edge ignored)" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 5);
    s.onLifecycleTransition(.busy, .busy, 20);
    try std.testing.expectEqual(@as(?usize, 5), s.active_turn_start);
}

test "current-turn thinking (index >= start) renders full; older collapses" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 10);
    try std.testing.expect(s.shouldRenderFull(10, false)); // live newest
    try std.testing.expect(s.shouldRenderFull(12, false)); // mid-turn committed
    try std.testing.expect(!s.shouldRenderFull(9, false)); // prior turn
    try std.testing.expect(!s.shouldRenderFull(0, false)); // oldest
}

test "after turn completion everything collapses unless operator_open" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 10);
    s.onLifecycleTransition(.busy, .ready, 14);
    try std.testing.expect(!s.shouldRenderFull(10, false));
    try std.testing.expect(!s.shouldRenderFull(13, false));
    // operator override still re-expands a row.
    try std.testing.expect(s.shouldRenderFull(10, true));
}

test "operator_open overrides even during an active turn" {
    var s: State = .{}; // no busy start: fully idle.
    try std.testing.expect(s.shouldRenderFull(0, true));
}

test "reset clears active_turn_start" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 8);
    s.reset();
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start);
}
