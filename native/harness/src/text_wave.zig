//! Generic reusable text wave — paints a string with a left-to-right cyclic
//! color wave driven by a tick phase. Same module shape as `rect_spinner.zig`:
//! callers pass a palette ramp (4-stop ColorRamp), a tag, and an id_extra
//! base. No dependency on busy row / bridge / clock.
//!
//! Wave algorithm: per-scalar `addText` with individual `.color_text` (the only
//! way to vary color per glyph in dvui). STEPS=3 sub-char smoothing gives ~6 s
//! full cycle for ~20 chars at 10 Hz.
//!
//! Color ramp: reuses `rect_spinner.ColorRamp` (4-stop LUT).
//! Reduced motion: phase 0 → fast-path solid `ramp[0]` on all glyphs (no
//! per-scalar wave, no near-black tail). Host skips tick pushes so phase
//! stays 0; an old host also leaves phase at 0 → same graceful solid output.

const std = @import("std");
const dvui = @import("dvui");
const rect_spinner = @import("rect_spinner.zig");

/// Sub-char smoothing steps: 3 steps per scalar for smooth travel.
pub const STEPS: usize = 3;

pub const Options = struct {
    /// The string to wave (e.g. "Waiting for model…").
    text: []const u8,
    /// Current tick phase from busyTick() (u8, wraps naturally).
    phase: u8,
    /// 4-step palette ramp: [head, trail1, trail2, rest].
    ramp: rect_spinner.ColorRamp,
    /// dvui tag for the inner textLayout (e.g. "busy-waiting-text").
    tag: []const u8,
    /// Base id for the inner textLayout's id_extra.
    id_extra: usize,
};

/// Count UTF-8 scalars in text. Returns 0 for empty.
pub fn countScalars(text: []const u8) usize {
    var n: usize = 0;
    var iter = (std.unicode.Utf8Iterator{ .bytes = text, .i = 0 });
    while (iter.nextCodepoint()) |_| {
        n += 1;
    }
    return n;
}

/// Compute the float sub-char head position for a given phase and scalar count N.
/// head = (phase % (N * STEPS)) / STEPS, or 0 when N == 0.
pub fn headPosition(phase: u8, N: usize) f32 {
    if (N == 0) return 0;
    const fN: f32 = @floatFromInt(N);
    const denom = fN * @as(f32, @floatFromInt(STEPS));
    const raw: f32 = @floatFromInt(phase);
    return @mod(raw, denom) / @as(f32, @floatFromInt(STEPS));
}

/// Cyclic distance from scalar index `i` to float head position `head` on a
/// ring of `N` elements. Returns 0 when N <= 1.
pub fn cyclicDistance(i: usize, head: f32, N: usize) f32 {
    if (N <= 1) return 0;
    const fi: f32 = @floatFromInt(i);
    const fN: f32 = @floatFromInt(N);
    const d = @abs(fi - head);
    return @min(d, fN - d);
}

/// Map cyclic distance to a 4-step color ramp index (0–3).
/// dist=0 → 0 (head), dist=N/2 → 3 (surface).
pub fn colorStep(dist: f32, N: usize) usize {
    if (N <= 1) return 0;
    const denom = @as(f32, @floatFromInt(N)) / 2.0;
    const raw = dist * 4.0 / denom;
    return @min(@as(usize, @intFromFloat(@floor(raw))), 3);
}

/// Paint the text wave: a `dvui.textLayout` with per-scalar color from the
/// ramp, driven by `opts.phase`. When phase == 0 (reduced motion / old host /
/// boot), all glyphs paint solid `ramp[0]` (warm_accent) — no per-scalar
/// wave, no near-black tail. Empty text → no-op (still creates + deinits
/// the textLayout so the caller's layout chain stays intact).
pub fn paint(src: std.builtin.SourceLocation, opts: Options) void {
    const N = countScalars(opts.text);

    var tl = dvui.textLayout(src, .{}, .{
        .expand = .horizontal,
        .background = false,
        .padding = dvui.Rect.all(0),
        .color_text = opts.ramp[0],
        .gravity_y = 0.5,
        .tag = opts.tag,
        .id_extra = opts.id_extra,
    });
    defer tl.deinit();

    if (N == 0) return;

    // Phase 0 (reduced motion / old host / boot): solid ramp[0] on all
    // glyphs — no wave. The cyclic distance formula maps only i=0 to ramp[0];
    // every other scalar would land at ramp[3] (warm_surface, ~1:1 on teal_bg)
    // — unreadable. Fast-path the whole string as one addText.
    if (opts.phase == 0) {
        tl.addText(opts.text, .{ .color_text = opts.ramp[0] });
        return;
    }

    const head = headPosition(opts.phase, N);

    var iter = (std.unicode.Utf8Iterator{ .bytes = opts.text, .i = 0 });
    var i: usize = 0;
    var prev_i: usize = 0;
    while (iter.nextCodepoint()) |_| {
        const slice = opts.text[prev_i..iter.i];
        prev_i = iter.i;
        const dist = cyclicDistance(i, head, N);
        const step = colorStep(dist, N);
        tl.addText(slice, .{ .color_text = opts.ramp[step] });
        i += 1;
    }
}
