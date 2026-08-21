//! Host unit tests for the Plan #732 tofu fix — seam constants pin that the
//! str_replace L2 old/new bands (`toolrun.zig`) and the collapsed thinking
//! preview (`thinking.zig`) paint via `addTextMixed` (face-aware: DejaVu
//! symbols + OpenMoji emoji paint their faces) instead of bare `addText`
//! (Vera/Noto .notdef tofu). Same seam pattern as `paint_diff.zig`'s
//! `diffTextPainter` / `paint_diff.test.zig`.
//!
//! Unlike a purely honor-system const, these two seams are **read at the paint
//! call sites**: each band/preview calls `mixed_text.addTextMixed(...)` inside
//! `switch (seam) { .mixed => ... }`, so the enum is genuinely consumed (not a
//! dead `pub const`). A flip of the seam to `.plain` both changes the real
//! render path back to face-blind `addText` AND fails these tests — the sink is
//! the flip the review break-scenario demanded. (Honor-system residual: an edit
//! *inside* the `.mixed` arm back to `addText` is not statically caught — the
//! same limitation `paint_diff`'s own seam carries.)
//!
//! This file transitively imports `bridge.zig` (Wasm-only `web-backend`), so
//! `build.zig` must provide the `web-backend` stub + `dvui` (testing backend) +
//! `zmd` imports, mirroring the queue_band/composer + paint_diff registrations.

const std = @import("std");
const t = std.testing;
const toolrun = @import("ui/toolrun.zig");
const thinking = @import("ui/thinking.zig");

test "str_replace L2 old/new bands use addTextMixed — strReplaceTextPainter seam is .mixed" {
    // One seam consumed at BOTH band call sites; assert it selects the
    // face-aware mixed path. A `.plain` flip reproduces tofu and fails here.
    try t.expectEqual(toolrun.StrReplaceTextPainter.mixed, toolrun.strReplaceTextPainter);
}

test "thinking collapsed preview uses addTextMixed — thinkingPreviewTextPainter seam is .mixed" {
    try t.expectEqual(thinking.ThinkingPreviewTextPainter.mixed, thinking.thinkingPreviewTextPainter);
}
