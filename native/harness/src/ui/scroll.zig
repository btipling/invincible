//! Pure ScrollInfo helpers — no mutable state, no dvui frame calls.
const dvui = @import("dvui");
const metrics = @import("metrics.zig");

pub fn isNearBottom(si: *const dvui.ScrollInfo) bool {
    return si.offsetFromMax(.vertical) <= metrics.NEAR_BOTTOM_PX;
}

pub fn clampScrollToContent(si: *dvui.ScrollInfo) void {
    const max_y = si.scrollMax(.vertical);
    if (si.viewport.y > max_y) si.viewport.y = max_y;
    if (si.viewport.y < 0) si.viewport.y = 0;
}

pub fn scrollToBottom(si: *dvui.ScrollInfo) void {
    si.viewport.y = si.scrollMax(.vertical);
}
