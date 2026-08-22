//! Host unit tests for `submit_queue.zig` (plan #664).
const std = @import("std");
const t = std.testing;
const sq = @import("submit_queue.zig");

test "push happy / peek / pop FIFO" {
    var q: sq.Q = .{};
    try sq.push(&q, "one");
    try sq.push(&q, "two");
    try sq.push(&q, "three");
    try t.expectEqual(@as(u32, 3), sq.count(&q));
    try t.expectEqualStrings("one", sq.peek(&q).?);
    sq.pop(&q);
    try t.expectEqualStrings("two", sq.peek(&q).?);
    sq.pop(&q);
    try t.expectEqualStrings("three", sq.peek(&q).?);
    sq.pop(&q);
    try t.expectEqual(@as(u32, 0), sq.count(&q));
    try t.expect(sq.peek(&q) == null);
}

test "push blank rejected" {
    var q: sq.Q = .{};
    try t.expectError(error.Blank, sq.push(&q, "   \n\t"));
    try t.expectError(error.Blank, sq.push(&q, ""));
    try t.expectEqual(@as(u32, 0), sq.count(&q));
}

test "push full rejects 17th" {
    var q: sq.Q = .{};
    var i: usize = 0;
    while (i < sq.MAX_ITEMS) : (i += 1) {
        try sq.push(&q, "x");
    }
    try t.expectError(error.Full, sq.push(&q, "overflow"));
    try t.expectEqual(@as(u32, sq.MAX_ITEMS), sq.count(&q));
}

test "removeAt middle compact" {
    var q: sq.Q = .{};
    try sq.push(&q, "a");
    try sq.push(&q, "b");
    try sq.push(&q, "c");
    sq.removeAt(&q, 1);
    try t.expectEqual(@as(u32, 2), sq.count(&q));
    try t.expectEqualStrings("a", sq.item(&q, 0).?);
    try t.expectEqualStrings("c", sq.item(&q, 1).?);
}

test "removeAt head is pop" {
    var q: sq.Q = .{};
    try sq.push(&q, "a");
    try sq.push(&q, "b");
    sq.removeAt(&q, 0);
    try t.expectEqualStrings("b", sq.peek(&q).?);
}

test "replaceAt updates; blank / bad index rejected" {
    var q: sq.Q = .{};
    try sq.push(&q, "old");
    try sq.replaceAt(&q, 0, "new");
    try t.expectEqualStrings("new", sq.peek(&q).?);
    try t.expectError(error.Blank, sq.replaceAt(&q, 0, "  "));
    try t.expectEqualStrings("new", sq.peek(&q).?);
    try t.expectError(error.BadIndex, sq.replaceAt(&q, 3, "nope"));
}

test "clear empties" {
    var q: sq.Q = .{};
    try sq.push(&q, "a");
    try sq.push(&q, "b");
    sq.clear(&q);
    try t.expectEqual(@as(u32, 0), sq.count(&q));
    try t.expect(sq.peek(&q) == null);
}

test "CRLF normalizes on push" {
    var q: sq.Q = .{};
    try sq.push(&q, "hello\r\nworld");
    try t.expectEqualStrings("hello\nworld", sq.peek(&q).?);
}

test "canPromote truth table" {
    const yes = sq.canPromote(.{
        .editing = false,
        .busy = false,
        .has_pending_submit = false,
        .has_pending_load_earlier = false,
        .count = 1,
    });
    try t.expect(yes);
    try t.expect(!sq.canPromote(.{
        .editing = true,
        .busy = false,
        .has_pending_submit = false,
        .has_pending_load_earlier = false,
        .count = 1,
    }));
    try t.expect(!sq.canPromote(.{
        .editing = false,
        .busy = true,
        .has_pending_submit = false,
        .has_pending_load_earlier = false,
        .count = 1,
    }));
    try t.expect(!sq.canPromote(.{
        .editing = false,
        .busy = false,
        .has_pending_submit = true,
        .has_pending_load_earlier = false,
        .count = 1,
    }));
    try t.expect(!sq.canPromote(.{
        .editing = false,
        .busy = false,
        .has_pending_submit = false,
        .has_pending_load_earlier = true,
        .count = 1,
    }));
    try t.expect(!sq.canPromote(.{
        .editing = false,
        .busy = false,
        .has_pending_submit = false,
        .has_pending_load_earlier = false,
        .count = 0,
    }));
}

var g_accept: bool = true;
var g_seen: usize = 0;

fn acceptSubmit(_: []const u8) bool {
    g_seen += 1;
    return g_accept;
}

test "promoteIf pops only after accept" {
    var q: sq.Q = .{};
    try sq.push(&q, "keep");
    g_accept = false;
    g_seen = 0;
    try t.expect(!sq.promoteIf(&q, acceptSubmit));
    try t.expectEqual(@as(usize, 1), g_seen);
    try t.expectEqualStrings("keep", sq.peek(&q).?);

    g_accept = true;
    try t.expect(sq.promoteIf(&q, acceptSubmit));
    try t.expectEqual(@as(u32, 0), sq.count(&q));
}

test "ITEM_BYTES matches the live Send cap" {
    try t.expectEqual(@as(usize, 262144), sq.ITEM_BYTES);
}

// ── plan #777 — paused guard (operator submit-queue hold) ─────────────────

test "canPromote: paused holds promote even when every other gate is met (plan #777)" {
    // All other guards pass (not editing, not busy, no pending submit/load,
    // non-empty queue) — the pause latch alone must refuse promotion.
    try t.expect(!sq.canPromote(.{
        .editing = false,
        .busy = false,
        .has_pending_submit = false,
        .has_pending_load_earlier = false,
        .count = 1,
        .paused = true,
    }));
    // Unpausing (default false) re-arms promote for the same otherwise-ready state.
    try t.expect(sq.canPromote(.{
        .editing = false,
        .busy = false,
        .has_pending_submit = false,
        .has_pending_load_earlier = false,
        .count = 1,
    }));
}

// ── plan #759 — insertFront (Continue-the-current-turn head) ──────────────

test "insertFront puts the new item at head, shifting existing items down one" {
    var q: sq.Q = .{};
    try sq.push(&q, "three");
    try sq.push(&q, "two");
    try sq.push(&q, "one"); // FIFO from head: three, two, one
    try sq.insertFront(&q, "zero");
    try t.expectEqual(@as(u32, 4), sq.count(&q));
    try t.expectEqualStrings("zero", sq.item(&q, 0).?);
    try t.expectEqualStrings("three", sq.item(&q, 1).?);
    try t.expectEqualStrings("two", sq.item(&q, 2).?);
    try t.expectEqualStrings("one", sq.item(&q, 3).?);
    // Previous head (three) is preserved at index 1 — nothing dropped.
}

test "insertFront normalizes (CRLF) and rejects blank, leaving the queue intact" {
    var q: sq.Q = .{};
    try sq.push(&q, "a");
    try t.expectError(error.Blank, sq.insertFront(&q, "   \n\t"));
    try t.expectError(error.Blank, sq.insertFront(&q, ""));
    try t.expectEqual(@as(u32, 1), sq.count(&q));
    try t.expectEqualStrings("a", sq.peek(&q).?);
    try sq.insertFront(&q, "b\r\nc");
    try t.expectEqualStrings("b\nc", sq.item(&q, 0).?);
}

test "insertFront is rejected at full capacity — no pop, no drop, no insert" {
    var q: sq.Q = .{};
    var i: usize = 0;
    while (i < sq.MAX_ITEMS) : (i += 1) {
        try sq.push(&q, "x");
    }
    try t.expectError(error.Full, sq.insertFront(&q, "overflow"));
    try t.expectEqual(@as(u32, sq.MAX_ITEMS), sq.count(&q));
    // Head is unchanged — the rejected insert never touched the FIFO.
    try t.expectEqualStrings("x", sq.peek(&q).?);
}

test "insertFront on a wrapped queue (head wraps) shifts across the wrap boundary" {
    var q: sq.Q = .{};
    // Fill + pop so head advances and later inserts wrap the physical array.
    try sq.push(&q, "a");
    try sq.push(&q, "b");
    sq.pop(&q); // head now index 1
    sq.pop(&q); // head now index 2
    try sq.push(&q, "keep1");
    try sq.push(&q, "keep2");
    try sq.insertFront(&q, "newhead");
    try t.expectEqual(@as(u32, 3), sq.count(&q));
    try t.expectEqualStrings("newhead", sq.item(&q, 0).?);
    try t.expectEqualStrings("keep1", sq.item(&q, 1).?);
    try t.expectEqualStrings("keep2", sq.item(&q, 2).?);
}

test "pending promote: insertFront then promoteIf pops the NEW head (not the old)" {
    var q: sq.Q = .{};
    try sq.push(&q, "old-head");
    try sq.insertFront(&q, "continue");
    g_accept = true;
    try t.expect(sq.promoteIf(&q, acceptSubmit));
    try t.expectEqualStrings("old-head", sq.peek(&q).?); // continue already consumed
    try t.expectEqual(@as(u32, 1), sq.count(&q));
}
