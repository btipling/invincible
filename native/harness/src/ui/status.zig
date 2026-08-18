//! Status-slot pack: paint + truncate helpers (plan #538/#541/#554).
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const metrics = @import("metrics.zig");
const bridge = @import("../bridge.zig");
const cwd_slot = @import("../cwd_slot.zig");

/// UTF-8 code-point byte length for the leading byte at `b` (defensive: bridge
/// slot values are already valid UTF-8, so a lead byte maps to its true length;
/// a stray continuation byte (0x80..0xBF) maps to 1 so we never over-read).
pub fn utf8CharLen(b: u8) usize {
    if (b < 0x80) return 1;
    if (b < 0xC0) return 1; // continuation byte — treat as a lone 1-byte unit
    if (b < 0xE0) return 2;
    if (b < 0xF0) return 3;
    return 4;
}

/// Cap a status-slot value to `MAX_STATUS_SLOT_LEN` bytes at a UTF-8 boundary
/// with a trailing ellipsis (never mojibake). The bridge already refuses
/// oversize pushes, but defends against a hostile pre-v14 wire value anyway.
pub fn truncateStatusValue(
    buf: *[bridge.MAX_STATUS_SLOT_LEN]u8,
    src: []const u8,
) []const u8 {
    if (src.len <= buf.len) return src;
    // Reserve 3 bytes for the UTF-8 ellipsis (U+2026 = \xE2\x80\xA6).
    var n: usize = buf.len - 3;
    // Back off a multibyte char truncated by the byte cap (never mojibake).
    while (n > 0 and (src[n] & 0xC0) == 0x80) n -= 1;
    @memcpy(buf[0..n], src[0..n]);
    @memcpy(buf[n .. n + 3], "…");
    return buf[0 .. n + 3];
}

/// Paint-time PIXEL ellipsizer (PR #543 re-run L9): shrink `src` to fit `max_w`
/// px as measured by `body`, keeping complete UTF-8 code points and a trailing
/// ellipsis. Only reached when the highest-priority status slot cannot fit at
/// full width on a very narrow canvas — so the operator still sees which sandbox
/// is bound (e.g. `sandbox 446655…`) instead of the whole pack painting nothing.
/// Never mutates the stored bridge value. Returns `src` unchanged when it already
/// fits; otherwise writes the ellipsized prefix into `buf` (caller-owned, >= the
/// slot cap) and returns a slice of it.
pub fn truncateToWidthPx(
    body: dvui.Font,
    buf: []u8,
    src: []const u8,
    max_w: f32,
) []const u8 {
    const ell = "…";
    if (max_w <= 0 or src.len == 0) return "";
    if (body.textSize(src).w <= max_w) return src;
    const ell_w = body.textSize(ell).w;
    var i: usize = 0;
    var used: f32 = 0;
    while (i < src.len) {
        const cl = @min(utf8CharLen(src[i]), src.len - i);
        // Leave room for the trailing ellipsis in the caller's byte buffer: a
        // cap-length slot whose prefix would fill buf entirely must still fit
        // the "…" (Nit L1 — a ≥94-byte cwd would otherwise return "" and leave
        // an empty gutter slot painted with just the 10px gap).
        if (i + cl + ell.len > buf.len) break;
        const cp = src[i .. i + cl];
        const w = body.textSize(cp).w;
        if (used + w + ell_w > max_w) break;
        @memcpy(buf[i .. i + cl], cp);
        used += w;
        i += cl;
    }
    if (i == 0 or i + ell.len > buf.len) return "";
    @memcpy(buf[i .. i + ell.len], ell);
    return buf[0 .. i + ell.len];
}

/// Width (px) available to the status-slot pack this frame. The pack lives on
/// line 2 of the two-line bottom status bar (plan #555 → #554, header merged by
/// plan #570); the budget is the bar's content-rect width minus the rounding-
/// safety pad (`STATUS_PACK_BUDGET_SAFETY`). Line 1 holds identity controls
/// (lifecycle · build id · model picker), so the pack shares the bar but each
/// line has its own fixed 32 px height — neither can displace the other. The pack
/// still DROPS slots per `STATUS_SLOT_DROP_ORDER` then pixel-ellipsizes the
/// survivor to fit, exactly as before (see the narrow-canvas ellipsize decision:
/// even here the operator still sees *which* sandbox is bound, PR #543 re-run L9).
pub fn statusPackMaxWidth() f32 {
    const content_w = dvui.parentGet().data().contentRect().w;
    return @max(0, content_w - metrics.STATUS_PACK_BUDGET_SAFETY);
}

/// Paint the right-aligned status-slot pack into line 2 of the two-line bottom
/// status bar (protocol v13, plan #538/#541/#554, header merged by plan #570).
/// Line 2 is a fixed 32 px horizontal row sharing the 64 px bar with the identity
/// row (line 1: lifecycle · build id · model picker); each line has its own
/// explicit height so neither can displace the other. A narrow canvas DROPS slots
/// per `STATUS_SLOT_DROP_ORDER` then pixel-ellipsizes the kept slot to fit.
/// Sandbox + cwd render as muted TEAL one-liners (WARM when busy); an empty slot
/// is hidden (never a blank placeholder / broken layout). When there are NO
/// non-empty slots at all, the caller still mounts the fixed `STATUS_BAR_H` band
/// as a subtle empty strip (locked decision, plan #555) — it never collapses and
/// `chrome_y`/`scroll_h` stay constant, so the transcript+composer stack never
/// jumps. Slot values are already capped at `MAX_STATUS_SLOT_LEN` by the bridge;
/// this defends the paint against a stale/oversize value with a UTF-8-safe ellipsis.
pub fn paintStatusSlots(life: bridge.Lifecycle) void {
    const busy = life == .busy;
    const budget = statusPackMaxWidth();
    if (budget <= 0) return;

    // Collect non-empty slots in drop-priority order (first = least important,
    // i.e. git → context → cwd → sandbox), with their truncated text + width.
    const body = (dvui.Options{}).fontGet();
    var slot: [bridge.MAX_STATUS_SLOTS]u32 = undefined;
    var buf: [bridge.MAX_STATUS_SLOTS][bridge.MAX_STATUS_SLOT_LEN]u8 = undefined;
    var text: [bridge.MAX_STATUS_SLOTS][]const u8 = undefined;
    var width: [bridge.MAX_STATUS_SLOTS]f32 = undefined;
    var n: usize = 0;
    for (bridge.STATUS_SLOT_DROP_ORDER) |s| {
        const raw = bridge.statusSlotValue(s);
        if (raw.len == 0) continue;
        // Cwd "." is the workspace-root default — hide the trivial chip (plan #579).
        if (s == bridge.STATUS_SLOT_CWD and !cwd_slot.isVisible(raw)) continue;
        slot[n] = s;
        text[n] = truncateStatusValue(&buf[n], raw);
        width[n] = body.textSize(text[n]).w + metrics.STATUS_SLOT_GAP;
        n += 1;
    }
    if (n == 0) return;

    // Drop lowest-importance slots (front of the drop order) until the pack fits
    // the primary-reserved budget. Retained = [keep_from..n).
    var total: f32 = 0;
    for (width[0..n]) |w| total += w;
    var keep_from: usize = 0;
    while (keep_from < n and total > budget) : (keep_from += 1) {
        total -= width[keep_from];
    }
    if (keep_from >= n) {
        // Even the most important slot (sandbox — last in the drop order) can't
        // fit at full width on a very narrow canvas. Never paint nothing (PR
        // #543 re-run L9): pixel-ellipsize that identity slot down to the leftover
        // budget so the operator still sees *which* sandbox is bound (e.g.
        // `sandbox 446655…`). This is the plan's "slots truncate" half that a
        // pure drop-to-empty would forfeit at exactly the viewport the plan locked.
        keep_from = n - 1;
        const max_text_w = budget - metrics.STATUS_SLOT_GAP;
        if (max_text_w <= 0) return; // no room even for the slot's gap — paint nothing
        text[keep_from] = truncateToWidthPx(body, buf[keep_from][0..], text[keep_from], max_text_w);
        if (text[keep_from].len == 0) return; // no room at all — no empty gutter (Nit L1)
    }

    const slot_color: dvui.Color = if (busy) palette.warm_accent else palette.teal_muted;
    // Right-aligned pack: gravity_x pulls the whole group to the trailing edge.
    var pack = dvui.box(@src(), .{ .dir = .horizontal }, .{
        .gravity_x = 1.0,
        .gravity_y = 0.5,
        .id_extra = 0x61_0001,
    });
    defer pack.deinit();

    var i = keep_from;
    while (i < n) : (i += 1) {
        var tl = dvui.textLayout(@src(), .{}, .{
            .background = false,
            .id_extra = 0x61_0002 + @as(usize, slot[i]),
            .color_text = slot_color,
            .gravity_y = 0.5,
            .margin = .{ .x = 0, .y = 0, .w = 10, .h = 0 },
        });
        tl.addText(text[i], .{});
        tl.deinit();
    }
}
