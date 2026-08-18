//! Host unit tests for `text_wave.zig` — pure LUT / position / distance logic;
//! no dvui frame dependency. Runs under `zig build test-rich`.
//!
//! Tests cover: SPEED-doubled head position (u32 multiply), directed trail
//! distance, comet color-step occupancy (capped at 2 = warm_border; rest of the
//! line accent), scalar count, empty/single-char edges, UTF-8 multi-byte
//! safety, and the phase-0 reduced-motion fast-path rationale.

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

test "countScalars: multi-byte UTF-8 (café = 4 scalars)" {
    try t.expectEqual(@as(usize, 4), text_wave.countScalars("café"));
}

test "countScalars: emoji (multi-byte) counts as one scalar" {
    // U+1F600 (😀) is 4 bytes, 1 scalar.
    const grinning = "😀";
    try t.expectEqual(@as(usize, 1), text_wave.countScalars(grinning));
}

test "headPosition: phase 0 on 10-char text → 0.0" {
    try t.expectApproxEqAbs(0.0, text_wave.headPosition(0, 10), 0.01);
}

test "headPosition: phase 7 on 10-char text → 4.667 (14/3, phase*2)" {
    // SPEED=2: raw = 7*2 = 14; period = 10*3 = 30; 14%30 = 14; /3 = 4.667.
    try t.expectApproxEqAbs(4.667, text_wave.headPosition(7, 10), 0.05);
}

test "headPosition: phase 60 on 20-char text wraps → 0.0" {
    // 20*3 = 60; raw = 60*2 = 120; 120%60 = 0; head = 0/3 = 0.
    try t.expectApproxEqAbs(0.0, text_wave.headPosition(60, 20), 0.01);
}

test "headPosition: phase 255 on 20-char text wraps via u32 (plan example)" {
    // raw = 255*2 = 510 (u32, no u8 overflow); 510%60 = 30; head = 30/3 = 10.0.
    try t.expectApproxEqAbs(10.0, text_wave.headPosition(255, 20), 0.01);
}

test "headPosition: N=18 loop period is 27 ticks (phase 0 and phase 27 → same head)" {
    // 18*3/2 = 27 ticks per loop at SPEED=2. phase 27 wraps to the same head as
    // phase 0 — a full loop in ~2.7 s at the locked 10 Hz host tick.
    try t.expectApproxEqAbs(text_wave.headPosition(0, 18), text_wave.headPosition(27, 18), 0.01);
    try t.expectApproxEqAbs(0.0, text_wave.headPosition(27, 18), 0.01);
}

test "headPosition: N=0 returns 0" {
    try t.expectEqual(@as(f32, 0.0), text_wave.headPosition(5, 0));
}

test "trailDistance: 0 at the head; increases behind the travel direction" {
    // Direction of travel is L→R; the trail sits behind (already-passed, left
    // of) the head. At head=5 on N=10:
    try t.expectApproxEqAbs(0.0, text_wave.trailDistance(5, 5.0, 10), 0.01); //  at head
    try t.expectApproxEqAbs(1.0, text_wave.trailDistance(4, 5.0, 10), 0.01); //  behind
    try t.expectApproxEqAbs(2.0, text_wave.trailDistance(3, 5.0, 10), 0.01); //  farther behind
    try t.expectApproxEqAbs(5.0, text_wave.trailDistance(0, 5.0, 10), 0.01); //  far behind
    // Ahead of the head (not yet swept) wraps to a large trail — accent rest.
    try t.expectApproxEqAbs(9.0, text_wave.trailDistance(6, 5.0, 10), 0.01);
    try t.expectApproxEqAbs(6.0, text_wave.trailDistance(9, 5.0, 10), 0.01);
}

test "trailDistance: rings around so a head at the string end keeps a contiguous behind trail" {
    // Head near the last scalar on N=18: index 17 is immediately behind it.
    try t.expectApproxEqAbs(0.0, text_wave.trailDistance(17, 17.0, 18), 0.01);
    try t.expectApproxEqAbs(1.0, text_wave.trailDistance(16, 17.0, 18), 0.01);
    // Index 0 is the head of the next ring pass — far ahead.
    try t.expectApproxEqAbs(17.0, text_wave.trailDistance(0, 17.0, 18), 0.01);
}

test "trailDistance: N=1 always returns 0" {
    try t.expectEqual(@as(f32, 0.0), text_wave.trailDistance(0, 7.5, 1));
}

test "trailDistance: N=0 always returns 0" {
    try t.expectEqual(@as(f32, 0.0), text_wave.trailDistance(0, 3.0, 0));
}

test "colorStep: comet spans — head accent, 2 muted, 1 dark, then accent rest" {
    // Absolute spans, no N-relative gradient:
    //  trail 0 → 0 (head, warm_accent)
    //  trail 1..2 → 1 (warm_muted)
    //  trail 3 → 2 (warm_border, one scalar)
    //  trail >= 4 → 0 (accent rest of the line)
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(0.0));
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(1.0));
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(2.0));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(3.0));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(4.0));
}

test "colorStep: far-from-head trail is step 0 (accent rest), not dark" {
    // The old N-relative curve put dist >= N/3 on warm_border; the comet keeps
    // everything past the 3-scalar trail on warm_accent.
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(4.0));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(5.0));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(10.0));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(17.0));
}

test "colorStep: never returns 3 (warm_border is the dark stop, not surface)" {
    var trail: f32 = 0.0;
    while (trail < 256.0) : (trail += 1.0) {
        const step = text_wave.colorStep(trail);
        try t.expect(step <= 2);
    }
    // Boundary is exact: the single dark scalar ends at 3; 4 is accent.
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(3.0));
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(4.0));
}

test "N=18 comet occupancy: exactly 1 dark, 2 muted, 15 accent (1 head + 14 rest)" {
    // Any integer head on a ring of 18 yields every trail 0..17 exactly once,
    // so the count is phase-invariant: 15 step-0 (head + 14 accent rest),
    // 2 step-1 (muted), 1 step-2 (border). Dark occupancy is 1/18, not ~6/18.
    var s0: usize = 0;
    var s1: usize = 0;
    var s2: usize = 0;
    var i: usize = 0;
    while (i < 18) : (i += 1) {
        const step = text_wave.colorStep(text_wave.trailDistance(i, 5.0, 18));
        switch (step) {
            0 => s0 += 1,
            1 => s1 += 1,
            2 => s2 += 1,
            else => unreachable,
        }
    }
    try t.expectEqual(@as(usize, 15), s0);
    try t.expectEqual(@as(usize, 2), s1);
    try t.expectEqual(@as(usize, 1), s2);
}

test "phase 0 domain: comet paints a dim tail at the trailing edge (fast-path rationale)" {
    // Plan #669 Goal 4 + DoD: reduced motion / old host → solid warm_accent.
    // The paint function fast-paths phase==0 with one addText. This test locks
    // the DOMAIN LOGIC that MAKES the fast-path necessary: with the directed
    // comet at head 0, the scalars immediately BEHIND index 0 on the ring are
    // the string's trailing edge, and they land on muted/border — not accent.
    // If someone removes the fast-path, reduced motion would show a stray dim
    // tail once per wrap.
    //
    // head=0, N=18: trailDistance(i, 0, 18) = mod(0 - i + 18, 18).
    // i=0  → trail 0  → step 0 (head)
    // i=15 → trail 3  → step 2 (dark)
    // i=16 → trail 2  → step 1 (muted)
    // i=17 → trail 1  → step 1 (muted)
    try t.expectEqual(@as(usize, 0), text_wave.colorStep(text_wave.trailDistance(0, text_wave.headPosition(0, 18), 18)));
    try t.expectEqual(@as(usize, 2), text_wave.colorStep(text_wave.trailDistance(15, text_wave.headPosition(0, 18), 18)));
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(text_wave.trailDistance(16, text_wave.headPosition(0, 18), 18)));
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(text_wave.trailDistance(17, text_wave.headPosition(0, 18), 18)));
}

test "UTF-8 safety: multi-byte scalar splits at codepoint boundary" {
    // "café" = 4 scalars: c(1B) a(1B) f(1B) é(2B)
    // Each scalar gets one addText slice; é is 2 bytes but one scalar.
    const N = text_wave.countScalars("café");
    try t.expectEqual(@as(usize, 4), N);
    // Head at scalar 2 (SPEED=2): phase 3 → raw=6, 6%12=6, /3=2.0.
    try t.expectApproxEqAbs(2.0, text_wave.headPosition(3, 4), 0.05);
    // Comet behind the head at scalar 2 → scalar 1 is muted (trail 1).
    try t.expectEqual(@as(usize, 1), text_wave.colorStep(text_wave.trailDistance(1, 2.0, 4)));
}

test "headPosition: continuity across the old 255→256 fold (plan #674 Goal 1)" {
    // The host sends 255, 256, 257, … monotonically. With the raw u32 stored
    // (no % 255 fold), adjacent host ticks advance by exactly one SPEED step
    // (~2/3 glyph at N=18, SPEED=2). The old fold produced a ~7.3-glyph jump.
    // 255: raw=510, 510%54=24, /3=8.0
    // 256: raw=512, 512%54=26, /3≈8.667
    try t.expectApproxEqAbs(8.0, text_wave.headPosition(255, 18), 0.01);
    try t.expectApproxEqAbs(8.667, text_wave.headPosition(256, 18), 0.05);
    const delta = text_wave.headPosition(256, 18) - text_wave.headPosition(255, 18);
    try t.expectApproxEqAbs(2.0 / 3.0, delta, 0.05); // one SPEED step
}

test "headPosition: interior step is also one SPEED increment" {
    try t.expectApproxEqAbs(4.667, text_wave.headPosition(7, 18), 0.05);
    try t.expectApproxEqAbs(5.333, text_wave.headPosition(8, 18), 0.05);
    const delta = text_wave.headPosition(8, 18) - text_wave.headPosition(7, 18);
    try t.expectApproxEqAbs(2.0 / 3.0, delta, 0.05);
}

test "headPosition: comet ring wrap still works (period = N*STEPS)" {
    // phase 27 = N*STEPS/SPEED = 18*3/2 — full comet loop.
    try t.expectApproxEqAbs(0.0, text_wave.headPosition(27, 18), 0.01);
    try t.expectApproxEqAbs(text_wave.headPosition(0, 18), text_wave.headPosition(27, 18), 0.01);
}

test "headPosition: u64 multiply — phase 1<<31 is not 0 (u32*SPEED would overflow)" {
    // phase = 2^31, raw = 2^32, period = 54 for N=18.
    // 2^32 % 54 = 22, head = 22/3 ≈ 7.333.
    // If headPosition used u32 multiply, 2^31 * 2 would overflow to 0 — head 0.
    try t.expectApproxEqAbs(7.333, text_wave.headPosition(1 << 31, 18), 0.05);
    // Not 0 — proves the u64 multiply path.
    try t.expect(@abs(text_wave.headPosition(1 << 31, 18)) > 0.01);
}

test "STEPS constant is 3, SPEED constant is 2" {
    try t.expectEqual(@as(usize, 3), text_wave.STEPS);
    try t.expectEqual(@as(u8, 2), text_wave.SPEED);
}
