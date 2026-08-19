//! Unit tests for composer_history.zig — pure data module (no dvui, no bridge).
//! Plan #667: composer arrow-key history.
const std = @import("std");
const hist = @import("composer_history.zig");
const testing = std.testing;

const KindText = hist.KindText;

fn makeMsgs(comptime kinds: []const u8) [2048]KindText {
    var msgs: [2048]KindText = undefined;
    @memset(&msgs, KindText{ .kind = 0, .text = "" });
    for (kinds, 0..) |k, i| {
        msgs[i] = KindText{ .kind = k, .text = "x" };
    }
    return msgs;
}

/// Build a slice of KindText with distinct text per row. Each user row
/// gets its own text label so `userTextAt` ordinals are verifiable.
fn buildMsgs(comptime rows: []const struct { kind: u8, text: []const u8 }) [2048]KindText {
    var msgs: [2048]KindText = undefined;
    @memset(&msgs, KindText{ .kind = 0, .text = "" });
    for (rows, 0..) |r, i| {
        msgs[i] = KindText{ .kind = r.kind, .text = r.text };
    }
    return msgs;
}

fn slice(msgs: []KindText, n: usize) []const KindText {
    return msgs[0..n];
}

// ── userCount ──────────────────────────────────────────────────────────────

test "userCount: empty → 0" {
    var msgs = makeMsgs(&[_]u8{});
    try testing.expectEqual(0, hist.userCount(slice(&msgs, 0)));
}

test "userCount: only user rows" {
    var msgs = makeMsgs(&[_]u8{ 1, 1, 1 });
    try testing.expectEqual(3, hist.userCount(slice(&msgs, 3)));
}

test "userCount: skips assistant/thinking/tool/skill/system/error" {
    var msgs = makeMsgs(&[_]u8{ 2, 5, 6, 7, 3, 4, 1 });
    try testing.expectEqual(1, hist.userCount(slice(&msgs, 7)));
}

// ── userTextAt (newest-first) ──────────────────────────────────────────────

test "userTextAt: ordinal 0 = last user in visible order" {
    var msgs = buildMsgs(&.{
        .{ .kind = 1, .text = "first" },
        .{ .kind = 2, .text = "ignored" },
        .{ .kind = 1, .text = "last" },
    });
    // visible: user(text="first"), assistant, user(text="last")
    // ordinal 0 = newest-first = the LAST user (index 2 → "last")
    const last = hist.userTextAt(slice(&msgs, 3), 0);
    try testing.expect(last != null);
    try testing.expectEqualStrings("last", last.?);
}

test "userTextAt: ordinal 1 = second-to-last user" {
    var msgs = buildMsgs(&.{
        .{ .kind = 1, .text = "first" },
        .{ .kind = 2, .text = "ignored" },
        .{ .kind = 1, .text = "last" },
    });
    // ordinal 1 = the first user (index 0 → "first")
    const second = hist.userTextAt(slice(&msgs, 3), 1);
    try testing.expect(second != null);
    try testing.expectEqualStrings("first", second.?);
}

test "userTextAt: out of range → null" {
    var msgs = makeMsgs(&[_]u8{1});
    const absent = hist.userTextAt(slice(&msgs, 1), 1);
    try testing.expectEqual(@as(?[]const u8, null), absent);
}

test "userTextAt: no user rows → null" {
    var msgs = makeMsgs(&[_]u8{ 2, 3, 5 });
    const absent = hist.userTextAt(slice(&msgs, 3), 0);
    try testing.expectEqual(@as(?[]const u8, null), absent);
}

// ── step — older ───────────────────────────────────────────────────────────

test "step: null older → load 0" {
    const r = hist.step(null, 3, .older);
    try testing.expectEqual(hist.Outcome.load, r.outcome);
    try testing.expectEqual(@as(?usize, 0), r.index);
}

test "step: null older, no user rows → noop" {
    const r = hist.step(null, 0, .older);
    try testing.expectEqual(hist.Outcome.noop, r.outcome);
    try testing.expectEqual(@as(?usize, null), r.index);
}

test "step: i=0 older → load 1" {
    const r = hist.step(0, 3, .older);
    try testing.expectEqual(hist.Outcome.load, r.outcome);
    try testing.expectEqual(@as(?usize, 1), r.index);
}

test "step: i=n-1 older → stay (noop)" {
    const r = hist.step(3, 4, .older);
    try testing.expectEqual(hist.Outcome.noop, r.outcome);
    try testing.expectEqual(@as(?usize, 3), r.index);
}

// ── step — newer ───────────────────────────────────────────────────────────

test "step: null newer → noop" {
    const r = hist.step(null, 3, .newer);
    try testing.expectEqual(hist.Outcome.noop, r.outcome);
    try testing.expectEqual(@as(?usize, null), r.index);
}

test "step: i=0 newer → restore_draft" {
    const r = hist.step(0, 3, .newer);
    try testing.expectEqual(hist.Outcome.restore_draft, r.outcome);
    try testing.expectEqual(@as(?usize, null), r.index);
}

test "step: i=2 newer → load 1" {
    const r = hist.step(2, 3, .newer);
    try testing.expectEqual(hist.Outcome.load, r.outcome);
    try testing.expectEqual(@as(?usize, 1), r.index);
}

// ── step — saturate ────────────────────────────────────────────────────────

test "step: i >= n, older → restore_draft" {
    // index 5 but only 3 user rows (ring shrunk)
    const r = hist.step(5, 3, .older);
    try testing.expectEqual(hist.Outcome.restore_draft, r.outcome);
    try testing.expectEqual(@as(?usize, null), r.index);
}

test "step: i >= n, newer → restore_draft" {
    const r = hist.step(5, 3, .newer);
    try testing.expectEqual(hist.Outcome.restore_draft, r.outcome);
    try testing.expectEqual(@as(?usize, null), r.index);
}

// ── edge: single user, walk both directions ─────────────────────────────────

test "step: single user, older from null → load 0" {
    const r = hist.step(null, 1, .older);
    try testing.expectEqual(hist.Outcome.load, r.outcome);
    try testing.expectEqual(@as(?usize, 0), r.index);
}

test "step: single user, older from 0 → stay" {
    const r = hist.step(0, 1, .older);
    try testing.expectEqual(hist.Outcome.noop, r.outcome);
    try testing.expectEqual(@as(?usize, 0), r.index);
}

test "step: single user, newer from 0 → restore_draft" {
    const r = hist.step(0, 1, .newer);
    try testing.expectEqual(hist.Outcome.restore_draft, r.outcome);
    try testing.expectEqual(@as(?usize, null), r.index);
}
