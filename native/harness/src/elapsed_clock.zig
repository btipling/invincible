//! Pure whole-turn busy-row clock formatting (protocol v14, plan #567).
//! Split out of `ui.zig` so the four `m:ss` / `h:mm:ss` cases are unit-testable
//! on the host runner (`build.zig` `test-rich`), mirroring `composer_text.zig`.

const std = @import("std");

/// Compact `m:ss` (two-digit seconds) or `h:mm:ss` past an hour — mirroring the
/// formatter of the removed DOM top-bar chip. `total_sec` comes from the host
/// wall-clock feed (`inv_set_turn_elapsed`); the Wasm is a passive receiver that
/// only formats into the caller-owned fixed stack buffer (no alloc / no
/// frame-budget traffic). A buffer too small to hold the padded form falls back
/// to `"0:00"`.
pub fn formatElapsedClock(dst: []u8, total_sec: u32) []const u8 {
    const sec: u32 = total_sec % 60;
    const m: u32 = total_sec / 60;
    const h: u32 = m / 60;
    if (h > 0) {
        return std.fmt.bufPrint(dst, "{d}:{d:0>2}:{d:0>2}", .{ h, m % 60, sec }) catch "0:00";
    }
    return std.fmt.bufPrint(dst, "{d}:{d:0>2}", .{ m, sec }) catch "0:00";
}

test {
    _ = @import("elapsed_clock.test.zig");
}
