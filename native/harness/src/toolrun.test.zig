//! Host unit tests for the Plan #732 tofu fix — seam constants that pin the
//! str_replace L2 old/new bands (`toolrun.zig`) and the collapsed thinking
//! preview (`thinking.zig`) to `addTextMixed` (face-aware: DejaVu symbols +
//! OpenMoji emoji paint their faces) instead of bare `addText` (Vera/Noto
//! .notdef tofu). Same seam pattern as `paint_diff.zig`'s `diffTextPainter` /
//! `paint_diff.test.zig`: a revert must flip the corresponding constant and
//! these tests fail.
//!
//! This file transitively imports `bridge.zig` (Wasm-only `web-backend`), so
//! `build.zig` must provide the `web-backend` stub + `dvui` (testing backend) +
//! `zmd` imports, mirroring the queue_band/composer + paint_diff registrations.

const std = @import("std");
const t = std.testing;
const toolrun = @import("ui/toolrun.zig");
const thinking = @import("ui/thinking.zig");

test "str_replace L2 old band uses addTextMixed — strReplaceTextPainter seam is .mixed" {
    try t.expectEqual(toolrun.StrReplaceTextPainter.mixed, toolrun.strReplaceTextPainter);
}

test "str_replace L2 new band uses addTextMixed — strReplaceTextPainter seam is .mixed" {
    try t.expectEqual(toolrun.StrReplaceTextPainter.mixed, toolrun.strReplaceTextPainter);
}

test "thinking collapsed preview uses addTextMixed — thinkingPreviewTextPainter seam is .mixed" {
    try t.expectEqual(thinking.ThinkingPreviewTextPainter.mixed, thinking.thinkingPreviewTextPainter);
}
