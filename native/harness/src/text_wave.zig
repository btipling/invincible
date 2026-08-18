//! Generic reusable text wave — paints a string with a left-to-right cyclic
//! color wave driven by a tick phase. Same module shape as `rect_spinner.zig`:
//! callers pass a palette ramp (4-stop ColorRamp), a tag, and an id_extra
//! base. No dependency on busy row / bridge / clock.
//!
//! Wave algorithm: per-scalar `addText` with individual `.color_text` (the only
//! way to vary color per glyph in dvui). STEPS=3 sub-char smoothing gives ~2.7 s
//! full cycle for 18 chars at 10 Hz (SPEED=2 doubles the head's advance per
//! tick — 18*3/2 = 27 ticks).
//!
//! Occupancy is a **localized directed comet** behind the traveling head, not a
//! full-ring gradient: at any phase the head scalar is `warm_accent`, the next
//! 2 scalars behind it are `warm_muted`, the next 1 is `warm_border`, and the
//! rest of the line stays `warm_accent` (readable). Dark occupancy is ≤ 1
//! scalar, never ~1/3 of the sentence.
//!
//! Color ramp: reuses `rect_spinner.ColorRamp` but caps at index 2 (warm_border
//! #3a2818) — warm_surface (#1a120c) is ~1:1 on teal_bg and unreadable as body
//! text. The 4-stop LUT exists for `rect_spinner` filled cells; text_wave stops
//! at step 2.
//!
//! Reduced motion: phase 0 → fast-path solid `ramp[0]` on all glyphs (no
//! per-scalar wave). Without it the comet would paint a dim muted/border tail
//! at the string's trailing edge whenever the wave phase sits near index 0.
//! The bridge reserves phase 0 for idle/stop/error — busy ticks map to 1..255
//! and wrap at 255→1 (never 0), so the animation never flashes a tail after
//! 12.8 s.

const std = @import("std");
const dvui = @import("dvui");
const rect_spinner = @import("rect_spinner.zig");

/// Sub-char smoothing steps: 3 steps per scalar for smooth travel.
pub const STEPS: usize = 3;
/// Head advance per tick. 2 doubles the wave speed: `N * STEPS / SPEED` ticks
/// per loop (18*3/2 = 27 ticks = ~2.7 s at 10 Hz).
pub const SPEED: u8 = 2;

/// Head scalar occupies `HEAD_SPAN` scalars (accent). Absolute paint constants —
/// not transport budgets.
pub const HEAD_SPAN: f32 = 1.0;
/// `warm_muted` scalars immediately behind the head.
pub const MUTED_SPAN: f32 = 2.0;
/// Single `warm_border` scalar behind the muted trail — the dark stop is one
/// scalar, not a third of the string.
pub const DARK_SPAN: f32 = 1.0;

pub const Options = struct {
    /// The string to wave (e.g. "Waiting for model…").
    text: []const u8,
    /// Current tick phase from busyTick() (u8, 1..255 while busy, 0 = idle).
    phase: u8,
    /// 4-step palette ramp: [head, trail1, trail2, rest]. text_wave caps at
    /// index 2 — ramp[3] is for rect_spinner off-cells, not body text.
    ramp: rect_spinner.ColorRamp,
    /// dvui tag for the inner textLayout (e.g. "busy-waiting-text").
    tag: []const u8,
    /// Base id for the inner textLayout's id_extra.
    id_extra: usize,
    /// Optional suffix appended at ramp[0] after all wave scalars, in the same
    /// textLayout (e.g. " · 0:01" for the busy clock). Keeps the clock in the
    /// same text run so kerning / middot spacing is correct.
    suffix_text: ?[]const u8 = null,
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
/// head = ((phase * SPEED) % (N * STEPS)) / STEPS, or 0 when N == 0.
/// The phase*SPEED multiply is done in u32 so phase 255*2 never overflows u8.
pub fn headPosition(phase: u8, N: usize) f32 {
    if (N == 0) return 0;
    const period: u32 = @intCast(N * STEPS); // e.g. 54 for N=18
    const raw: u32 = @as(u32, phase) * @as(u32, SPEED); // 255*2 must not wrap u8
    return @as(f32, @floatFromInt(raw % period)) / @as(f32, @floatFromInt(STEPS));
}

/// How far scalar index `i` sits *behind* the float head on a ring of `N`
/// scalars: 0 at the head, increasing toward the tail (the direction of
/// travel). Ring-wrapped so a head near the end of the string still has a
/// contiguous behind-it trail. Returns 0 when N <= 1.
pub fn trailDistance(i: usize, head: f32, N: usize) f32 {
    if (N <= 1) return 0;
    const fN: f32 = @floatFromInt(N);
    const fi: f32 = @floatFromInt(i);
    return @mod(head - fi + fN, fN);
}

/// Map a trail distance to a color ramp index (0–2). Capped at 2 (warm_border)
/// — never returns 3 (warm_surface, unreadable as body text on teal_bg).
/// trail < HEAD_SPAN → 0 (head, warm_accent); then MUTED_SPAN of step 1;
/// then DARK_SPAN of step 2; everything farther behind → step 0 (accent rest).
/// Occupancy is absolute scalars — no N-relative full-ring gradient.
pub fn colorStep(trail: f32) usize {
    if (trail < HEAD_SPAN) return 0;
    if (trail < HEAD_SPAN + MUTED_SPAN) return 1;
    if (trail < HEAD_SPAN + MUTED_SPAN + DARK_SPAN) return 2;
    return 0; // rest of the line — accent
}

/// Paint the text wave: a `dvui.textLayout` with per-scalar color from the
/// ramp, driven by `opts.phase`. When phase == 0 (reduced motion / idle /
/// boot), all glyphs paint solid `ramp[0]` (warm_accent) — no per-scalar
/// wave. Empty text → no-op (still creates + deinits the textLayout so the
/// caller's layout chain stays intact).
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

    if (N == 0) {
        if (opts.suffix_text) |suffix| {
            tl.addText(suffix, .{ .color_text = opts.ramp[0] });
        }
        return;
    }

    // Phase 0 is reserved by the bridge for idle/stop/error — busy ticks are
    // 1..255 and wrap 255→1 (never 0). So phase 0 reliably means reduced
    // motion, old host, or boot. Fast-path the whole string as one addText
    // at ramp[0] — no wave, no dim comet tail (at head 0 the scalars right
    // behind index 0 on the ring would land muted/border).
    if (opts.phase == 0) {
        tl.addText(opts.text, .{ .color_text = opts.ramp[0] });
        if (opts.suffix_text) |suffix| {
            tl.addText(suffix, .{ .color_text = opts.ramp[0] });
        }
        return;
    }

    const head = headPosition(opts.phase, N);

    var iter = (std.unicode.Utf8Iterator{ .bytes = opts.text, .i = 0 });
    var i: usize = 0;
    var prev_i: usize = 0;
    while (iter.nextCodepoint()) |_| {
        const slice = opts.text[prev_i..iter.i];
        prev_i = iter.i;
        const trail = trailDistance(i, head, N);
        const step = colorStep(trail);
        tl.addText(slice, .{ .color_text = opts.ramp[step] });
        i += 1;
    }

    if (opts.suffix_text) |suffix| {
        tl.addText(suffix, .{ .color_text = opts.ramp[0] });
    }
}
