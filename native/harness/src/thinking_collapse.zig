//! Pure transcript "thinking collapse" policy (#424).
//!
//! Host-unit-tested (no dvui / wasm frame), mirroring `composer_text.zig` /
//! `ring_slot.zig` seams. The rule locked here:
//!
//!   - While the harness is **Busy**, every thinking row that belongs to the
//!     current turn renders the FULL monologue — the operator is still reading
//!     the active turn's chain of thought, including the live `update_last`
//!     newest slot.
//!   - When a turn **completes** (Busy -> ready/err), every committed thinking
//!     row collapses to the compact expandable control. Re-clicking a row opens
//!     it (operator set lives in `ui/state.zig`, in-memory only — thinking is
//!     ephemeral and never survives refresh).
//!
//! Turn membership is decided by **physical ring-slot contiguity**, not by a
//! logical visible-index threshold. The Busy turn occupies the physical slots
//! written from the busy-start slot up to the current ring head (forward,
//! wrapping at capacity), so a row belongs iff its slot's forward distance from
//! the busy-start slot is less than the turn's current extent. This is correct
//! even when the ring is **saturated** (`msg_count == capacity`) or has
//! **wrapped** — cases where an index threshold (`i >= msg_count`) would
//! silently saturate at `capacity`, never match any painted index, and drop the
//! active turn's committed thinking to collapsed mid-Busy.
//!
//! No dvui, no bridge export, no protocol change.
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
    /// Physical ring slot where the current Busy turn began appending — the slot
    /// the ring head pointed at when the turn went idle->busy (i.e. the next slot
    /// whose write starts this turn). `null` while idle (ready/err/boot). Using
    /// the *physical slot* (not a logical `msg_count` threshold) is what keeps
    /// membership correct under ring saturation and wrap — see `isActiveTurnFull`.
    active_turn_start_slot: ?usize = null,

    /// Reset for a cleared / reloaded transcript.
    pub fn reset(self: *State) void {
        self.active_turn_start_slot = null;
    }

    /// Record the active-turn start on a real idle->busy transition; clear it on
    /// busy->ready/err so committed thinking collapses. `busy_start_slot` is the
    /// physical ring slot the turn began appending at (the head at the busy
    /// edge) — NOT a message count, so it never saturates when the ring is full.
    pub fn onLifecycleTransition(self: *State, prev: Lifecycle, next: Lifecycle, busy_start_slot: usize) void {
        const was_busy = prev == .busy;
        const is_busy = next == .busy;
        if (is_busy and !was_busy) {
            self.active_turn_start_slot = busy_start_slot;
        } else if (was_busy and !is_busy) {
            self.active_turn_start_slot = null;
        }
    }

    /// Ring-forward distance (in slots, mod `cap`) from slot `start` to `slot`.
    /// The Busy turn writes consecutive physical slots from its start, so every
    /// turn message sits at a small forward distance; anything committed *before*
    /// the turn sits at a distance that approaches `cap` and stays out of range.
    fn forward(start: usize, slot: usize, cap: usize) usize {
        return (slot + cap - start) % cap;
    }

    /// Whether a message in physical ring slot `slot` belongs to the current Busy
    /// turn. `head` is the current ring head (next slot to be written); `cap` is
    /// the ring capacity (bridge `MAX_MSG`).
    ///
    /// The turn occupies the slots `[start_slot, head)` forward, so a slot is
    /// part of it iff its forward distance from `start_slot` is less than the
    /// turn's current extent (`(head - start_slot) mod cap`). Because it reasons
    /// in physical-slot ring order rather than a logical `i >= msg_count` index,
    /// it is immune to two ring pathologies: (1) saturation — an index threshold
    /// pin at `cap` never matches, since painted indices top out at `cap - 1`;
    /// and (2) wrap desync — as the ring wraps, indices shift while a fixed
    /// threshold would go stale, whereas `head` tracks every write.
    pub fn isActiveTurnFull(self: *const State, slot: usize, head: usize, cap: usize) bool {
        const start = self.active_turn_start_slot orelse return false;
        const extent = (head + cap - start) % cap; // number of writes this turn, mod cap
        return forward(start, slot, cap) < extent;
    }

    /// Whether a thinking row in physical ring slot `slot` should render the FULL
    /// monologue: True when the operator explicitly opened it, OR (when thinking
    /// is NOT default-collapsed) it is part of the current Busy turn. Otherwise
    /// it renders collapsed.
    ///
    /// `default_collapsed` is the "thinking default = collapsed" preference
    /// (plan #742): when ON (the default), even active-turn rows render
    /// collapsed unless the operator opened them — the Busy pin is relaxed so
    /// live reasoning starts out collapsed too. When OFF, the today-Busy pin is
    /// restored: active-turn rows stay full regardless of the operator set.
    ///
    /// This is THE policy API — callers render full iff it returns true. The
    /// preference is threaded as an explicit boolean parameter — the module
    /// stays PURE (imports nothing), so the host unit suite can exercise both
    /// preference values without a dvui/bridge frame. Callers pass the live
    /// `state.thinking_default_collapsed` (product default `true`). Operator-
    /// open rows (committed, outside the active turn) can be toggled back off;
    /// a pinned-active row (preference OFF) stays full regardless.
    pub fn shouldRenderFull(
        self: *const State,
        slot: usize,
        head: usize,
        cap: usize,
        operator_open: bool,
        default_collapsed: bool,
    ) bool {
        return operator_open or (!default_collapsed and self.isActiveTurnFull(slot, head, cap));
    }
};

test "idle->busy records busy_start_slot; busy->ready clears it" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 7);
    try std.testing.expectEqual(@as(?usize, 7), s.active_turn_start_slot);

    s.onLifecycleTransition(.busy, .ready, 11);
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start_slot);
}

test "busy->err clears busy_start_slot too" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 3);
    s.onLifecycleTransition(.busy, .err, 9);
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start_slot);
}

test "non-busy transitions do not move busy_start_slot" {
    var s: State = .{};
    // ready->ready, boot->ready: no busy edge, start stays null.
    s.onLifecycleTransition(.ready, .ready, 2);
    s.onLifecycleTransition(.boot, .ready, 3);
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start_slot);
}

test "busy->busy keeps the original start (re-busy edge ignored)" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 5);
    s.onLifecycleTransition(.busy, .busy, 20);
    try std.testing.expectEqual(@as(?usize, 5), s.active_turn_start_slot);
}

test "current-turn thinking (its ring slots) renders full; older collapses" {
    var s: State = .{};
    const cap: usize = 2048;
    s.onLifecycleTransition(.ready, .busy, 100);
    // head advanced to 103 -> 3 turn writes in slots 100, 101, 102.
    try std.testing.expect(s.isActiveTurnFull(100, 103, cap)); // live newest
    try std.testing.expect(s.isActiveTurnFull(101, 103, cap)); // mid-turn committed
    try std.testing.expect(s.isActiveTurnFull(102, 103, cap));
    try std.testing.expect(!s.isActiveTurnFull(99, 103, cap)); // prior turn (before start)
    try std.testing.expect(!s.isActiveTurnFull(0, 103, cap)); // oldest
}

test "after turn completion everything collapses unless operator_open" {
    var s: State = .{};
    const cap: usize = 2048;
    s.onLifecycleTransition(.ready, .busy, 100);
    s.onLifecycleTransition(.busy, .ready, 204);
    try std.testing.expect(!s.isActiveTurnFull(100, 204, cap));
    try std.testing.expect(!s.isActiveTurnFull(203, 204, cap));
    // operator override still re-expands a row (true regardless of preference).
    try std.testing.expect(s.shouldRenderFull(100, 204, cap, true, true));
}

test "operator_open overrides even during an active turn" {
    var s: State = .{}; // no busy start: fully idle.
    const cap: usize = 2048;
    try std.testing.expect(s.shouldRenderFull(0, 1, cap, true, true));
}

test "reset clears busy_start_slot" {
    var s: State = .{};
    s.onLifecycleTransition(.ready, .busy, 8);
    s.reset();
    try std.testing.expectEqual(@as(?usize, null), s.active_turn_start_slot);
}

test "saturating a full ring does not collapse the active turn's committed thinking" {
    // Regression for review CONCERN (Major): when the ring is already full
    // (`msg_count == capacity`), an index threshold `i >= msg_count` can never
    // match (visible indices top out at `capacity - 1`), so the active turn's
    // committed thinking would collapse mid-Busy. Physical ring membership must
    // keep every non-newest active-turn slot full.
    var s: State = .{};
    const cap: usize = 2048;
    s.onLifecycleTransition(.ready, .busy, 0); // full window; turn starts at slot 0
    // Turn appends thinking to slots 0,1,2,3; head now 4. msg_count is pinned at
    // cap, yet every active-turn slot is still full.
    try std.testing.expect(s.isActiveTurnFull(0, 4, cap));
    try std.testing.expect(s.isActiveTurnFull(1, 4, cap));
    try std.testing.expect(s.isActiveTurnFull(3, 4, cap)); // non-newest committed segment
    try std.testing.expect(!s.isActiveTurnFull(cap - 1, 4, cap)); // pre-turn oldest stays collapsed
}

test "ring wrap keeps the busy turn full and stale prior turn collapsed" {
    var s: State = .{};
    const cap: usize = 8; // tiny ring so the test forces a wrap.
    s.onLifecycleTransition(.ready, .busy, cap - 2);
    // head wrapped to 3 -> 5 turn writes: slots 6, 7, 0, 1, 2.
    try std.testing.expect(s.isActiveTurnFull(cap - 2, 3, cap));
    try std.testing.expect(s.isActiveTurnFull(cap - 1, 3, cap));
    try std.testing.expect(s.isActiveTurnFull(0, 3, cap));
    try std.testing.expect(s.isActiveTurnFull(1, 3, cap));
    try std.testing.expect(s.isActiveTurnFull(2, 3, cap));
    // Pre-turn slot (written before the turn began) collapses despite wrap.
    try std.testing.expect(!s.isActiveTurnFull(5, 3, cap));
    // head slot 3 is the next write — not yet part of the turn.
    try std.testing.expect(!s.isActiveTurnFull(3, 3, cap));
}

test "shouldRenderFull is the single policy API: default (collapsed ON) relaxes the busy pin" {
    // Plan #742 test 1 — default `default_collapsed = true`: a Busy-turn thinking
    // row renders COLLAPSED (not full) unless the operator opened it. Today's
    // always-pin is now gated behind the OFF preference value.
    var s: State = .{};
    const cap: usize = 2048;
    s.onLifecycleTransition(.ready, .busy, 0);
    // Active-turn row is NOT rendered full by default anymore.
    try std.testing.expect(!s.shouldRenderFull(0, 4, cap, false, true));
    try std.testing.expect(!s.shouldRenderFull(1, 4, cap, false, true));
    // operator_open still expands an active-turn row (expander works mid-Busy).
    try std.testing.expect(s.shouldRenderFull(0, 4, cap, true, true));
    // Pre-turn (older) row stays collapsed under both open states.
    try std.testing.expect(!s.shouldRenderFull(cap - 1, 4, cap, false, true));
}

test "shouldRenderFull: preference OFF restores the busy-turn pin (today)" {
    // Plan #742 test 2 — `default_collapsed = false`: Busy-turn thinking stays
    // full even when operator_open is false (unchanged today behavior).
    var s: State = .{};
    const cap: usize = 2048;
    s.onLifecycleTransition(.ready, .busy, 0);
    try std.testing.expect(s.shouldRenderFull(0, 4, cap, false, false));
    try std.testing.expect(s.shouldRenderFull(1, 4, cap, false, false));
    // Pre-turn (older) row still collapses unless opened.
    try std.testing.expect(!s.shouldRenderFull(cap - 1, 4, cap, false, false));
    try std.testing.expect(s.shouldRenderFull(cap - 1, 4, cap, true, false));
    // After turn completion, operator_open is the only path to full.
    s.onLifecycleTransition(.busy, .ready, 4);
    try std.testing.expect(!s.shouldRenderFull(0, 4, cap, false, false));
    try std.testing.expect(s.shouldRenderFull(0, 4, cap, true, false));
}

test "shouldRenderFull: committed rows are collapsed unless operator_open under both preference values" {
    // Plan #742 test 3 — after the turn completes, committed thinking collapses
    // regardless of the preference; only operator_open re-expands.
    var s: State = .{};
    const cap: usize = 2048;
    s.onLifecycleTransition(.ready, .busy, 100);
    s.onLifecycleTransition(.busy, .ready, 204);
    for ([_]bool{ true, false }) |def| {
        try std.testing.expect(!s.shouldRenderFull(100, 204, cap, false, def));
        try std.testing.expect(!s.shouldRenderFull(203, 204, cap, false, def));
        // operator override still re-expands a committed row.
        try std.testing.expect(s.shouldRenderFull(100, 204, cap, true, def));
    }
}
