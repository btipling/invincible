//! Host unit tests for `text_wave.zig` — pure LUT / position / distance logic;
//! no dvui frame dependency. Runs under `zig build test-rich`.
//!
//! Tests cover: head position, cyclic distance, color-step mapping (capped at 2
//! = warm_border), scalar count, empty/single-char edges, UTF-8 multi-byte
//! safety, and full-cycle ramp coverage.

const std = @import("std");
const t = std.testing;
const text_wave = @import("text_wave.zig");

test "countScalars: empty string → 0" {
    try t.expectEqual(@as(usize, 0), text_wave.countScalars(""));
}

test "countScalars: ASCII + ellipsis = 18 scalars" {
    // "Waiting for model…": W(1) a(2) i(3) t(4) i(5) n(6) g(7) ' '(8)
    // f(9) o(10) r(11) ' '(12) m(13) o(14) d(15) e(16) l(17) …(18)
    try t.expectEqual(@as(usize, 18), text_wave.countScalars("Waiting for model\u{2026}"));
}

test "phase 0 domain: tail scalars are NOT all step 0 (why the fast-path exists)" {
    // Plan #655 Goal 4 + DoD row 8: reduced motion / old host → solid
    // warm_accent. The paint function fast-paths phase==0 with one addText.
    // This test locks the DOMAIN LOGIC that MAKES the fast-path necessary:
    // without it, tail scalars at head=0 would land at step 2 (warm_border),
    // not step 0. If someone removes the fast-path, this test reminds them
    // that the domain formula does NOT equal "solid" at phase 0.
    //
    // head at 0: cyclicDistance(i, 0, 18) = min(i, 18-i) = i for i≤9
    // N=18, denom=9. colorStep uses 3.0 multiplier, capped at 2.
    // i=0: dist=0, raw=0*3/9=0 → step 0 (head)
    // i=1: dist=1, raw=1*3/9=0.33 → step 0
    // i=3: dist=3, raw=3*3/9=1 → step 1 (warm_muted trail)
    // i=6: dist=6, raw=6*3/9=2 → step 2 (warm_border tail)
    // i=9: dist=9, raw=9*3/9=3 → min(3,2)=2 (warm_border, capped)
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(text_wave.cyclicDistance(0, 0.0, 18), 18));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(text_wave.cyclicDistance(1, 0.0, 18), 18));
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(text_wave.cyclicDistance(3, 0.0, 18), 18));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(text_wave.cyclicDistance(6, 0.0, 18), 18));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(text_wave.cyclicDistance(9, 0.0, 18), 18));
}

test "phase 0: head at 0 smoke (first and last scalars)" {
    // head = 0/3 = 0.0: cyclicDistance(0, 0.0, 18) = 0 → step 0 (head)
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(text_wave.cyclicDistance(0, text_wave.headPosition(0, 18), 18), 18));
    // cyclicDistance(9, 0.0, 18) = 9, N=18, denom=9, raw=9*3/9=3 → min(3,2)=2 (warm_border cap)
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(text_wave.cyclicDistance(9, 0.0, 18), 18));
}

test "countScalars: multi-byte UTF-8 (café = 4 scalars)" {
    try t.expectEqual(@as(usize, 4), text_wave.countScalars("café"));
}

test "headPosition: phase 0 on 10-char text → 0.0" {
    try t.expectApproxEqAbs(0.0, text_wave.headPosition(0, 10), 0.01);
}

test "headPosition: phase 7 on 10-char text → 2.333 (7/3)" {
    try t.expectApproxEqAbs(2.333, text_wave.headPosition(7, 10), 0.05);
}

test "headPosition: phase 60 on 20-char text wraps → 0.0" {
    // 20 * 3 = 60; phase 60 % 60 = 0; head = 0/3 = 0
    try t.expectApproxEqAbs(0.0, text_wave.headPosition(60, 20), 0.01);
}

test "headPosition: phase 255 on 20-char text wraps correctly" {
    // 20 * 3 = 60; 255 % 60 = 15; head = 15/3 = 5.0
    try t.expectApproxEqAbs(5.0, text_wave.headPosition(255, 20), 0.01);
}

test "headPosition: N=0 returns 0" {
    try t.expectEqual(@as(f32, 0.0), text_wave.headPosition(5, 0));
}

test "cyclicDistance: head at 5 on 10-char text (plan example)" {
    // i=0: min(|0-5|, 10-5) = min(5,5) = 5
    try t.expectApproxEqAbs(5.0, text_wave.cyclicDistance(0, 5.0, 10), 0.01);
    // i=5: min(|5-5|, 10-5) = 0
    try t.expectApproxEqAbs(0.0, text_wave.cyclicDistance(5, 5.0, 10), 0.01);
    // i=9: min(4, 6) = 4
    try t.expectApproxEqAbs(4.0, text_wave.cyclicDistance(9, 5.0, 10), 0.01);
    // i=6: min(1, 9) = 1
    try t.expectApproxEqAbs(1.0, text_wave.cyclicDistance(6, 5.0, 10), 0.01);
    // i=1: min(4, 6) = 4
    try t.expectApproxEqAbs(4.0, text_wave.cyclicDistance(1, 5.0, 10), 0.01);
}

test "cyclicDistance: N=1 always returns 0" {
    try t.expectEqual(@as(f32, 0.0), text_wave.cyclicDistance(0, 7.5, 1));
}

test "cyclicDistance: N=0 always returns 0" {
    try t.expectEqual(@as(f32, 0.0), text_wave.cyclicDistance(0, 3.0, 0));
}

test "colorStep: distance 0 → step 0 (head, warm_accent)" {
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(0.0, 10));
}

test "colorStep: distance 5 on N=10 → step 2 (warm_border cap, not surface)" {
    // N=10, denom=5. dist=5: raw=5*3/5=3 → min(3,2)=2 (capped at warm_border).
    // Before the cap (multiplier 4.0, max 3) this was step 3 = warm_surface.
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(5.0, 10));
}

test "colorStep: N=1 always returns 0" {
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(100.0, 1));
}

test "colorStep: all 3 stops exercised across full distance range on N=20" {
    // N=20, max distance = 10, denom = 10.
    // 3.0 multiplier, capped at 2:
    // dist 0:   0*3/10 = 0.0 → step 0 (warm_accent)
    // dist 2:   2*3/10 = 0.6 → step 0
    // dist 4:   4*3/10 = 1.2 → step 1 (warm_muted)
    // dist 7:   7*3/10 = 2.1 → step 2 (warm_border cap)
    // dist 10: 10*3/10 = 3.0 → min(3,2)=2 (warm_border, capped)
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(0.0, 20));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(2.0, 20));
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(4.0, 20));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(7.0, 20));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(10.0, 20));
}

test "colorStep: N=2 (two chars) — head and opposite" {
    // N=2, max cyclic dist = 1. denom = 1.0.
    // dist 0 → 0*3/1 = 0 → step 0
    // dist 1 → 1*3/1 = 3 → min(3,2) = 2 (capped)
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(0.0, 2));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(1.0, 2));
}

test "UTF-8 safety: multi-byte scalar splits at codepoint boundary" {
    // "café" = 4 scalars: c(1B) a(1B) f(1B) é(2B)
    // Each scalar gets one addText slice; é is 2 bytes but one scalar.
    const N = text_wave.countScalars("café");
    try t.expectEqual(@as(usize, 4), N);
    // Verify the head position computation works for this N.
    try t.expectApproxEqAbs(2.0, text_wave.headPosition(6, 4), 0.05);
    // cyclic distance for i=1, head=2.0, N=4:
    // |1-2.0| = 1.0; min(1.0, 3.0) = 1.0
    // denom = 2.0, raw = 1.0*3/2 = 1.5 → floor 1 → step 1
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(text_wave.cyclicDistance(1, 2.0, 4), 4));
}

test "countScalars: emoji (multi-byte) counts as one scalar" {
    // U+1F600 (😀) is 4 bytes, 1 scalar.
    const grinning = "😀";
    try t.expectEqual(@as(usize, 1), text_wave.countScalars(grinning));
}

test "STEPS constant is 3" {
    try t.expectEqual(@as(usize, 3), text_wave.STEPS);
}
