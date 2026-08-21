//! Thinking-row paint: expandable control + full GFM monologue (#424).
//! Test seam: ThinkingPreviewTextPainter / thinkingPreviewTextPainter pins that
//! the collapsed thinking preview uses addTextMixed (face-aware), not the
//! face-blind addText (Noto .notdef tofu for symbols/emoji). A revert must flip
//! this constant; toolrun.test.zig fails if it does.
pub const ThinkingPreviewTextPainter = enum { mixed, plain };
pub const thinkingPreviewTextPainter: ThinkingPreviewTextPainter = .mixed;

const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("../bridge.zig");
const palette = @import("../palette.zig");
const chip_preview = @import("../chip_preview.zig");
const mixed_text = @import("../rich/mixed_text.zig");
const rich = @import("../rich/root.zig");
const state = @import("state.zig");
const metrics = @import("metrics.zig");
const chrome = @import("chrome.zig");

/// One-line muted preview of a thinking monologue for the collapsed header
/// (text-only, bounded — no markdown parse, no full-body read). Returns a slice
/// into `buf`. Stops at the first newline and caps at ~80 bytes. Review: the
/// byte cap must never cut a multi-byte UTF-8 sequence mid-codepoint (CJK,
/// emoji, combining marks) — that would hand `textLayout` an invalid trailing
/// run, so we back off any truncated multibyte char to a codepoint boundary.
pub fn thinkingPreview(buf: *[96]u8, text: []const u8) []const u8 {
    var out: usize = 0;
    for (text) |c| {
        if (out >= 80) break;
        if (c == '\n' or c == '\r') break;
        buf[out] = c;
        out += 1;
    }
    // Trailing whitespace isn't part of the preview.
    while (out > 0 and (buf[out - 1] == ' ' or buf[out - 1] == '\t')) out -= 1;
    // Drop a multi-byte char truncated by the byte cap: first any trailing
    // continuation bytes, then a truncated leading byte (0xC0..0xFF). What's
    // left ends on a valid single-byte (ASCII) boundary — never mojibake.
    while (out > 0 and chip_preview.isUtf8Continuation(buf[out - 1])) out -= 1;
    if (out > 0 and (buf[out - 1] & 0xC0) == 0xC0) out -= 1;
    return buf[0..out];
}

/// Paint a thinking row (protocol v8 kind / bridge kind 5, #424).
///
/// When the row belongs to the active Busy turn (or the operator has expanded
/// it), render the FULL GFM monologue through the existing slot-keyed markdown
/// painter. Otherwise render a compact default-collapsed control mirroring the
/// tool-run L0 header: a `Thinking` expander + a bounded muted one-line preview
/// + a Copy button (copies the full source). Toggling flips the in-memory open
/// set so a committed row the operator opens stays open until re-toggled or the
/// transcript is cleared.
///
/// id namespace: `msg_index *% 1000033` (odd prime, distinct from tool-run's
/// `1000003` and the body's `1024`) so thinking chrome never aliases other rows'
/// tool-run/body ids.
pub fn paintThinking(
    src: std.builtin.SourceLocation,
    msg_index: usize,
    text: []const u8,
    slot: ?usize,
    revision: u32,
) void {
    const id_base: usize = @as(usize, msg_index) *% 1000033;
    const key: dvui.Id = @enumFromInt(id_base + 7);

    // Active-turn rows are pinned FULL while Busy (policy) — not togglable.
    // Committed rows are operator-toggled: `state.thinking_open_l1` is the only input.
    // Membership is the policy's job (pure, host-tested) — the live streaming
    // newest row is part of the active turn's ring-forward slot range, so it
    // stays full automatically (no ui-side `is_live_newest` escape hatch). The
    // policy took over the saturated-ring guard the old index-threshold used.
    const slotp = slot orelse {
        // A thinking row always maps to a ring slot; bail defensively rather
        // than derive membership from a bare visible index.
        return;
    };
    const ring_head = bridge.messageHead();
    const ring_cap = bridge.RING_CAP;
    const is_active = state.thinking_collapse_state.isActiveTurnFull(slotp, ring_head, ring_cap);
    const open_by_operator = state.thinking_open_l1.contains(key);
    // Single policy entry point — both the active-turn pin and the operator
    // override live inside `shouldRenderFull`.
    const full = state.thinking_collapse_state.shouldRenderFull(slotp, ring_head, ring_cap, open_by_operator);

    // Layout mutates `expanded` across the head + body blocks below. Starts at
    // the policy/output state; for a pinned active-turn row we re-assert `full`
    // after the expander so a click cannot collapse the live reasoning.
    var expanded = full;
    {
        var head = dvui.box(src, .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 120, .h = metrics.TOUCH_H - 4 },
            // same warm surface as the kind row uses for thinking (kindFill 5).
            .background = true,
            .color_fill = palette.warm_bg,
            .color_border = palette.teal_border,
            .padding = .{ .x = 8, .y = 2, .w = 8, .h = 2 },
            .id_extra = id_base + 1,
        });
        defer head.deinit();

        // Natural label height + gravity_y centers caret with preview/copy trail.
        const open = dvui.expander(src, "Thinking", .{ .expanded = &expanded }, .{
            .expand = .horizontal,
            .gravity_y = 0.5,
            .id_extra = id_base + 2,
            .color_text = palette.warm_muted,
            .font = .theme(.heading),
        });
        if (is_active) {
            // Pinned; never let a click collapse the live/active-turn reasoning.
            expanded = true;
        } else if (open) {
            state.thinking_open_l1.put(key, {}) catch {};
            expanded = true;
        } else {
            _ = state.thinking_open_l1.remove(key);
            expanded = false;
        }

        var trail = dvui.box(src, .{ .dir = .horizontal }, .{
            .gravity_x = 1.0,
            .gravity_y = 0.5,
            .min_size_content = .{ .w = 0, .h = metrics.TOUCH_H - 8 },
            .id_extra = id_base + 3,
        });
        defer trail.deinit();

        // Collapsed: bounded muted one-line preview (no markdown parse).
        if (!expanded) {
            var preview_buf: [96]u8 = undefined;
            const preview = thinkingPreview(&preview_buf, text);
            var tl = dvui.textLayout(src, .{}, .{
                .id_extra = id_base + 4,
                .color_text = palette.teal_muted,
                .gravity_y = 0.5,
                .font = .theme(.body),
                .margin = .{ .x = 0, .y = 0, .w = 6, .h = 0 },
            });
            // Plan #732: preview via addTextMixed — symbols/emoji paint their
            // DejaVu/OpenMoji faces (not Noto .notdef tofu). `{}` opts preserve
            // the layout's teal_muted ink. Seam switch read here, so a flip to
            // `.plain` genuinely reproduces the face-blind tofu path (and the
            // toolrun.test.zig seam test fails).
            switch (thinkingPreviewTextPainter) {
                .mixed => mixed_text.addTextMixed(tl, preview, .theme(.body), .{}),
                .plain => tl.addText(preview, .{}),
            }
            tl.deinit();
        }
        // Copy button (full source → clipboard), same chrome as tool-run header.
        if (dvui.button(src, "📋", .{}, .{
            .gravity_y = 0.5,
            .style = .content,
            .id_extra = id_base + 5,
            .min_size_content = .{ .w = 22, .h = 22 },
            .padding = .{ .x = 4, .y = 4, .w = 4, .h = 4 },
            .font = chrome.chromeCopyFont(),
            .corners = .round(5),
            .color_fill = palette.teal_bg,
            .color_text = palette.teal_accent,
            .color_border = palette.teal_border,
        })) {
            dvui.clipboardTextSet(text);
        }
    }

    // Full GFM monologue when expanded (functionally unchanged paint path; the
    // slot-keyed parse cache + cache_layout handling is preserved).
    if (expanded) {
        rich.paintMessageBody(src, rich.KIND_THINKING, text, .{
            .msg_index = msg_index,
            .slot = slot,
            .revision = revision,
        });
    }
}
