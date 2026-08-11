//! #404 per-slot decoded tool-run cache (protocol v10 / kind 6).
//!
//! The frame loop re-paints every in-ring tool-run row each `dvui_update()`, and
//! `toolrun.decode` allocates a fresh decoded summary into the per-frame arena
//! every time — O(tool-run items) per row per frame. This growable cache is
//! keyed on (physical ring slot, write-revision): an unchanged revision reuses
//! the previously decoded summary (zero re-decode), and only a slot write
//! (`push` / `update_last`) re-decodes — O(dirty), not O(N).
//!
//! Unlike the paint-time decode (which used the per-frame arena and is dropped
//! every frame), cached summaries must outlive the frame, so they are allocated
//! from a persistent allocator (`setAllocator`, wired to `WebBackend.gpa`) and
//! `deinit`'d on overwrite / `clear()`. Pure (no dvui / bridge import) so it is
//! host-unit-testable in `zig build test-rich`.
const std = @import("std");
const toolrun = @import("toolrun.zig");

const Allocator = std.mem.Allocator;

const SlotEntry = struct {
    revision: u32 = 0,
    /// Owned; deinit on overwrite/clear.
    decoded: ?toolrun.Decoded = null,
};

var parent_allocator: ?Allocator = null;
var slots: std.ArrayList(SlotEntry) = .empty;

/// Persistent allocator for cached decoded summaries (set once from init, e.g.
/// WebBackend.gpa). Must not be the per-frame arena.
pub fn setAllocator(a: Allocator) void {
    parent_allocator = a;
}

/// Decode-and-cache `text` for (physical slot, revision), reusing the cached
/// summary when the revision is unchanged. Returns a pointer to the decoded
/// run (caller must NOT free) or null on decode failure / alloc failure —
/// caller paints fail-open raw text (same contract as `toolrun.decode`).
pub fn parseSlot(slot: usize, revision: u32, text: []const u8) ?*const toolrun.ToolRun {
    const a = parent_allocator orelse return null;
    while (slots.items.len <= slot) {
        slots.append(a, .{}) catch return null;
    }
    const e = &slots.items[slot];
    if (e.decoded != null and e.revision == revision) {
        return &e.decoded.?.run;
    }
    if (e.decoded != null) {
        e.decoded.?.deinit();
        e.decoded = null;
    }
    const dec = toolrun.decode(a, text) orelse return null;
    e.revision = revision;
    e.decoded = dec;
    return &e.decoded.?.run;
}

/// Deinit all cached summaries and drop slot storage (used on ring clear /
/// truncate / redeploy so a fresh or old surface starts cold).
pub fn clear() void {
    for (slots.items) |*e| {
        if (e.decoded) |*d| d.deinit();
        e.decoded = null;
    }
    slots.clearRetainingCapacity();
}

/// Test helper: number of slot entries currently holding a decoded summary.
pub fn liveCount() usize {
    var n: usize = 0;
    for (slots.items) |*e| {
        if (e.decoded != null) n += 1;
    }
    return n;
}

/// Test helper: free the ArrayList backing buffer under the allocator that owns
/// it (host tests only — production uses a long-lived gpa and never needs this).
pub fn releaseForTest() void {
    clear();
    if (parent_allocator) |a| slots.deinit(a);
    slots = .empty;
    parent_allocator = null;
}

test "parseSlot decode hit/re-decode on revision, clear drops storage" {
    setAllocator(std.testing.allocator);
    defer releaseForTest();

    const text =
        "toolrun\t1\t2/0/0\n" ++
        "1\tok\tread_file\tread_file ok\tread_file · ✓\n" ++
        "2\tok\texec\t\texec · ✓ · exit=0\n";
    try std.testing.expectEqual(@as(usize, 0), liveCount());

    // Revision 1 → fresh decode.
    const r1 = parseSlot(0, 1, text);
    try std.testing.expect(r1 != null);
    try std.testing.expectEqual(@as(u32, 2), r1.?.ok);
    try std.testing.expectEqual(@as(usize, 2), r1.?.items.len);
    try std.testing.expectEqual(@as(usize, 1), liveCount());

    // Unchanged revision → reuses the cached summary (deterministic: the cached
    // entry is returned directly, no re-decode), still one live.
    const r2 = parseSlot(0, 1, text);
    try std.testing.expect(r2 != null);
    try std.testing.expect(r2.? == r1.?);
    try std.testing.expectEqual(@as(usize, 1), liveCount());

    // Bumped revision (stream growth / ring reuse) → re-decode: content reflects
    // the grown payload (3 items / pending>0), not the cached 2-item summary.
    const grew =
        "toolrun\t1\t2/0/1\n" ++
        "1\tok\tread_file\tread_file ok\tread_file · ✓\n" ++
        "2\tok\texec\t\texec · ✓ · exit=0\n" ++
        "3\trunning\tcat\t\tcat · …\n";
    const r3 = parseSlot(0, 2, grew);
    try std.testing.expect(r3 != null);
    try std.testing.expectEqual(@as(u32, 2), r3.?.ok);
    try std.testing.expectEqual(@as(u32, 1), r3.?.pending);
    try std.testing.expectEqual(@as(usize, 3), r3.?.items.len);
    try std.testing.expectEqual(@as(usize, 1), liveCount());

    // Distinct physical slots are isolated (ring wrap can't alias).
    const r4 = parseSlot(9, 1, text);
    try std.testing.expect(r4 != null);
    try std.testing.expectEqual(@as(usize, 2), liveCount());

    // clear() deinits every cached summary and drops references.
    clear();
    try std.testing.expectEqual(@as(usize, 0), liveCount());
}

test "parseSlot fails open on bad payload / unknown version" {
    setAllocator(std.testing.allocator);
    defer releaseForTest();
    try std.testing.expect(parseSlot(0, 1, "not a toolrun") == null);
    try std.testing.expect(parseSlot(0, 1, "toolrun\t99\t1/0/0") == null);
    try std.testing.expect(parseSlot(0, 1, "") == null);
    try std.testing.expectEqual(@as(usize, 0), liveCount());
}

test "parseSlot null allocator is fail-open" {
    parent_allocator = null;
    clear();
    try std.testing.expect(parseSlot(0, 1, "toolrun\t1\t0/0/0") == null);
}
