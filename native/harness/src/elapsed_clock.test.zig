//! Host unit tests for `elapsed_clock.zig` (no dvui frame — runs in
//! `build.zig` `test-rich` on the self-hosted runner).
//!
//! Each test owns its format buffer (declared in the test fn frame) and passes
//! it to `fmt`, which returns a slice into it — so the returned slice always
//! points at memory that outlives the helper call (no stack-pointer-after-return
//! pitfall). Review L6 fix: a helper that forms a slice into its *own* local buf
//! would return a dangling pointer that only happens to work when inlined.

const std = @import("std");
const t = std.testing;
const elapsed_clock = @import("elapsed_clock.zig");

const BUF_LEN = 16;

/// Formats `total_sec` into the caller-owned `buf` and returns a slice of it,
/// so the caller controls the buffer lifetime (it must outlive the read).
fn fmt(buf: []u8, total_sec: u32) []const u8 {
    return elapsed_clock.formatElapsedClock(buf, total_sec);
}

test "sub-minute is m:ss with two-digit seconds" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("0:00", fmt(&buf, 0));
    try t.expectEqualStrings("0:01", fmt(&buf, 1));
    try t.expectEqualStrings("0:59", fmt(&buf, 59));
}

test "minute boundary is m:ss with two-digit seconds" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("1:00", fmt(&buf, 60));
    try t.expectEqualStrings("1:07", fmt(&buf, 67));
    try t.expectEqualStrings("9:59", fmt(&buf, 599));
    try t.expectEqualStrings("42:00", fmt(&buf, 42 * 60));
}

test "full minute rolls the seconds back to zero and carries the minute" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("2:00", fmt(&buf, 120));
    try t.expectEqualStrings("2:30", fmt(&buf, 150));
}

test "hour rollover is h:mm:ss with zero-padded minutes/seconds" {
    var buf: [BUF_LEN]u8 = undefined;
    try t.expectEqualStrings("1:00:00", fmt(&buf, 3600));
    try t.expectEqualStrings("1:02:05", fmt(&buf, 3725));
    try t.expectEqualStrings("2:00:00", fmt(&buf, 7200));
    try t.expectEqualStrings("2:15:09", fmt(&buf, 2 * 3600 + 15 * 60 + 9));
}

test "undersized buffer falls back to 0:00 instead of corrupting memory" {
    var small: [2]u8 = undefined;
    try t.expectEqualStrings("0:00", elapsed_clock.formatElapsedClock(small[0..], 3725));
}

test "second-level digit padding is never dropped" {
    var buf: [BUF_LEN]u8 = undefined;
    // 90s = 1m30s, not "1:3".
    try t.expectEqualStrings("1:30", fmt(&buf, 90));
    // 65s = 1m05s (zero-padded), not "1:5".
    try t.expectEqualStrings("1:05", fmt(&buf, 65));
}
