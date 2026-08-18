//! Host unit tests for `rect_spinner.zig` constant ramps — pure data, no
//! dvui frame, runs in `build.zig` `test-rich` on the self-hosted runner.
//!
//! Plan #651 L6 lock: TEAL_IDLE_RAMP must be four identical `teal_muted`
//! entries so the idle grid paints a uniform static grid with no pulse.

const std = @import("std");
const t = std.testing;
const rs = @import("rect_spinner.zig");
const palette = @import("palette.zig");

test "TEAL_IDLE_RAMP: all four entries are teal_muted" {
    for (rs.TEAL_IDLE_RAMP, 0..) |color, i| {
        try t.expectEqual(palette.teal_muted, color);
        _ = i;
    }
}

test "TEAL_IDLE_RAMP: length is 4" {
    try t.expectEqual(@as(usize, 4), rs.TEAL_IDLE_RAMP.len);
}
