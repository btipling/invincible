//! Host dvui testing-backend tests for `mixed_text.lookalikePaintFont` (PR #595
//! adversarial-review Minor L6). Pins that the U+2015 separator lookalike is
//! ALWAYS painted on Noto body at the surrounding run's size, regardless of the
//! `base` face (mono / body / symbols). This is the exact gap that let #594 (and
//! its re-review) ship a wrong face while tests stayed green — `unicode_face.zig`
//! only maps CPs → U+2015; nothing asserted the *paint face*.
//!
//! No pixels, no SDL/GLFW/OpenGL. dvui's testing backend resolves fonts from the
//! harness theme (Noto/OpenMoji/DejaVu symbols/Vera Mono) via the app window, but
//! `lookalikePaintFont` needs no frame — it only rebuilds a Font struct. We init
//! the testing backend so `palette.fontBody()`/`fontMono()` resolve the theme's
//! real family names.

const std = @import("std");
const t = std.testing;
const dvui = @import("dvui");
const palette = @import("palette.zig");
const mixed_text = @import("rich/mixed_text.zig");

// Build a mono `base` (Vera) at a non-default size, then assert the lookalike
// switches to Noto body but preserves the size. Vera does NOT embed U+2015, so
// this is the fence / inline-code path that tofued before the fix (#594 miss).
test "lookalikePaintFont: mono base becomes Noto body at base size" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    const base = palette.fontMono().withSize(24).withWeight(.bold).withStyle(.italic);
    const look = mixed_text.lookalikePaintFont(base);

    // Face is Noto body, not Vera mono, not DejaVu symbols.
    try t.expectEqualStrings(palette.family_body, look.familyName());
    try t.expect(!std.mem.eql(u8, palette.family_mono, look.familyName()));
    // Surrounding run's size / weight / style are inherited.
    try t.expectApproxEqAbs(base.size, look.size, 0.001);
    try t.expectEqual(base.weight, look.weight);
    try t.expectEqual(base.style, look.style);
    // Strike is carried through (from the base run, if any).
    try t.expectEqual(base.strike, look.strike);
}

// A body base stays body (identity on family), only size is carried.
test "lookalikePaintFont: body base stays body and carries size" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    const base = palette.fontBody().withSize(44);
    const look = mixed_text.lookalikePaintFont(base);

    try t.expectEqualStrings(palette.family_body, look.familyName());
    try t.expectApproxEqAbs(44.0, look.size, 0.001);
}

// The lookalike face is unconditionally Noto body — even a symbols base
// (DejaVu subset, which also lacks U+2015) must not leak through.
test "lookalikePaintFont: symbols base still resolves to Noto body" {
    var tr = try dvui.testing.init(.{});
    defer tr.deinit();

    const base = palette.fontSymbols().withSize(14);
    const look = mixed_text.lookalikePaintFont(base);

    try t.expectEqualStrings(palette.family_body, look.familyName());
    try t.expectApproxEqAbs(14.0, look.size, 0.001);
}
