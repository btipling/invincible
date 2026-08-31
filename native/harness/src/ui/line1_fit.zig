//! Pure line-1 overflow decisions (plan #906).
//!
//! Locked drop order:
//!   1. spinner always kept
//!   2. drop `h:{build-id}` first
//!   3. ellipsize then drop provider
//!   4. ellipsize effort
//!   5. ellipsize model
//!
//! Widths include each widget's chrome (trigger overhead / gaps). Caller
//! still pixel-ellipsizes labels with `status.truncateToWidthPx`.

pub const Drop = struct {
    paint_build_id: bool,
    /// Remaining px for the provider widget (text + gap). 0 = hide.
    provider_max_w: f32,
};

/// First-pass drop: spinner is already reserved by the caller (`budget` is the
/// full line budget; `spinner_w` is subtracted here).
pub fn dropLine1(
    budget: f32,
    spinner_w: f32,
    build_id_w: f32,
    model_w: f32,
    effort_w: f32,
    provider_w: f32,
) Drop {
    const rest = @max(0, budget - spinner_w);
    var paint_build_id = build_id_w > 0;
    var provider_max_w: f32 = provider_w;

    const with_all = (if (paint_build_id) build_id_w else 0) + model_w + effort_w + provider_w;
    if (with_all > rest) {
        paint_build_id = false;
    }
    const after_build = model_w + effort_w + provider_w;
    if (after_build > rest and provider_w > 0) {
        const avail = rest - model_w - effort_w;
        if (avail <= 0) {
            provider_max_w = 0;
        } else {
            provider_max_w = avail;
        }
    }
    return .{ .paint_build_id = paint_build_id, .provider_max_w = provider_max_w };
}

test "plenty of space keeps build-id and full provider" {
    const t = @import("std").testing;
    const d = dropLine1(400, 13, 40, 80, 60, 50);
    try t.expect(d.paint_build_id);
    try t.expectEqual(@as(f32, 50), d.provider_max_w);
}

test "overflow drops build-id first and keeps provider" {
    const t = @import("std").testing;
    // spinner 13 + build 80 + model 120 + effort 80 + provider 50 = 343 > 280
    const d = dropLine1(280, 13, 80, 120, 80, 50);
    try t.expect(!d.paint_build_id);
    try t.expectEqual(@as(f32, 50), d.provider_max_w);
}

test "tight budget ellipsizes then drops provider before touching model" {
    const t = @import("std").testing;
    // After dropping build-id: model 150 + effort 100 + provider 50, rest = 200-13=187
    // avail for provider = 187-150-100 = -63 → drop provider.
    const d = dropLine1(200, 13, 80, 150, 100, 50);
    try t.expect(!d.paint_build_id);
    try t.expectEqual(@as(f32, 0), d.provider_max_w);
}

test "narrow ~390 px: drop build-id, shrink provider, keep model+effort" {
    const t = @import("std").testing;
    // Typical 390-wide content ~370 after pad. spinner 13, build 70, model 140,
    // effort 90, provider 70 → 383 > 370 so drop build (313 remaining widgets
    // vs rest 357) — provider stays (maybe ellipsized by caller if still over).
    const d = dropLine1(370, 13, 70, 140, 90, 70);
    try t.expect(!d.paint_build_id);
    try t.expect(d.provider_max_w > 0);
}
