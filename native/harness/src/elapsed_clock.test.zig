//! Host unit tests for `elapsed_clock.zig` (no dvui frame — runs in
//! `build.zig` `test-rich` on the self-hosted runner).

const std = @import("std");
const t = std.testing;
const elapsed_clock = @import("elapsed_clock.zig");

const BUF: [16]u8 = undefined;

fn fmt(total_sec: u32) []const u8 {
    var buf: [BUF.len]u8 = BUF;
    return elapsed_clock.formatElapsedClock(buf[0..], total_sec);
}

test "sub-minute is m:ss with two-digit seconds" {
    try t.expectEqualStrings("0:00", fmt(0));
    try t.expectEqualStrings("0:01", fmt(1));
    try t.expectEqualStrings("0:59", fmt(59));
}

test "minute boundary is m:ss with two-digit seconds" {
    try t.expectEqualStrings("1:00", fmt(60));
    try t.expectEqualStrings("1:07", fmt(67));
    try t.expectEqualStrings("9:59", fmt(599));
    try t.expectEqualStrings("42:00", fmt(42 * 60));
}

test "full minute rolls the seconds back to zero and carries the minute" {
    try t.expectEqualStrings("2:00", fmt(120));
    try t.expectEqualStrings("2:30", fmt(150));
}

test "hour rollover is h:mm:ss with zero-padded minutes/seconds" {
    try t.expectEqualStrings("1:00:00", fmt(3600));
    try t.expectEqualStrings("1:02:05", fmt(3725));
    try t.expectEqualStrings("2:00:00", fmt(7200));
    try t.expectEqualStrings("2:15:09", fmt(2 * 3600 + 15 * 60 + 9));
}

test "undersized buffer falls back to 0:00 instead of corrupting memory" {
    var small: [2]u8 = undefined;
    try t.expectEqualStrings("0:00", elapsed_clock.formatElapsedClock(small[0..], 3725));
}

test "second-level digit padding is never dropped" {
    // 90s = 1m30s, not "1:3".
    try t.expectEqualStrings("1:30", fmt(90));
    // 65s = 1m05s (zero-padded), not "1:5".
    try t.expectEqualStrings("1:05", fmt(65));
}
