//! Sticky last-user-message chip (plan #645, source issue #339).
//! Paints a compact strip above the transcript scroll area when the last user
//! message has scrolled above the viewport. One click scrolls back to it.
const std = @import("std");
const dvui = @import("dvui");
const bridge = @import("../bridge.zig");
const palette = @import("../palette.zig");
const chip_preview = @import("../chip_preview.zig");
const mixed_text = @import("../rich/mixed_text.zig");
const state = @import("state.zig");
const scroll = @import("scroll.zig");
const metrics = @import("metrics.zig");
const status = @import("status.zig");

/// Paint the sticky last-user-message chip as an absolute-rect strip above the
/// transcript scroll area (plan #645). The entire strip is a clickable button:
/// one click scrolls the transcript so the last user message is aligned at the
/// top of the viewport. The chip shows a truncated one-line preview of the user
/// message; hidden when the message is already visible or there are no user
/// messages.
pub fn paintLastUserChip(
    src: std.builtin.SourceLocation,
    slot: usize,
    chip_y: f32,
    pane_w: f32,
    avail: dvui.Rect,
) void {
    // Find the user message text for this physical ring slot.
    const n = bridge.messageCount();
    var chip_text: []const u8 = "";
    for (0..n) |i| {
        if (bridge.messageSlotAt(i)) |s| {
            if (s == slot) {
                if (bridge.messageAt(i)) |m| {
                    chip_text = m.text;
                }
                break;
            }
        }
    }

    var preview_buf: [chip_preview.LAST_USER_CHIP_PREVIEW_MAX_BYTES + 1]u8 = undefined;
    const preview = chip_preview.chipPreview(&preview_buf, chip_text);

    // Pixel-ellipsize the preview to fit the available chip width on narrow
    // canvas (~390 px phone with open rail). " ↑" suffix + 16 px total
    // horizontal padding must be reserved so the label never overflows and
    // dvui clips mid-glyph (adversarial review #646 Minor L9).
    //
    // U+2191 is in the Arrows block — Noto body does not ship it (tofu). DejaVu
    // Symbols does. Measure the arrow on the symbols face; paint the combined
    // label through addTextMixed (same face split as rich text). Do **not** pin
    // `.font = fontSymbols()` on the whole chip — that face has no Latin
    // (adversarial review #648 Blocker).
    const body = dvui.Font.theme(.body);
    const font_symbols = palette.fontSymbols().withSize(body.size);
    const chip_w = @max(0, avail.w - pane_w);
    const suffix = " ↑";
    const suffix_w = body.textSize(" ").w + font_symbols.textSize("↑").w;
    const max_text_w = @max(0, chip_w - 16 - suffix_w);
    var ellip_buf: [chip_preview.LAST_USER_CHIP_PREVIEW_MAX_BYTES + 4]u8 = undefined;
    const display_preview = if (body.textSize(preview).w <= max_text_w)
        preview
    else
        status.truncateToWidthPx(body, &ellip_buf, preview, max_text_w);

    // Preview (Noto) + " ↑" (DejaVu) — mixed in one label, same as rich text.
    var label_buf: [chip_preview.LAST_USER_CHIP_PREVIEW_MAX_BYTES + 8]u8 = undefined;
    const label = std.fmt.bufPrint(&label_buf, "{s}{s}", .{ display_preview, suffix }) catch display_preview;

    // Same as dvui.button but the label is addTextMixed, not labelNoFmt (one
    // face). ButtonWidget so the strip stays one click target.
    var bw: dvui.ButtonWidget = undefined;
    bw.init(src, .{}, .{
        .rect = .{ .x = pane_w, .y = chip_y, .w = @max(0, avail.w - pane_w), .h = metrics.TOUCH_H },
        .expand = .horizontal,
        .style = .content,
        .min_size_content = .{ .w = 120, .h = metrics.TOUCH_H },
        .color_fill = palette.teal_border,
        .color_border = palette.teal_muted,
        // Explicit all-sides 1 px border (plan #748 / source #747): without it
        // the unset `.border` width resolves to a 0-px default in dvui, so
        // `color_border = teal_muted` never paints and the chip's bottom edge
        // reads as a code-diff header or bleeds into the first message. Same
        // shape the composer field uses (composer_chrome.zig). Paints inside
        // the chip's own rect, so TOUCH_H / scrollArea position are unchanged.
        .border = .{ .x = 1, .y = 1, .w = 1, .h = 1 },
        .color_text = palette.teal_text,
        .margin = dvui.Rect.all(0),
        .padding = .{ .x = 8, .y = 0, .w = 8, .h = 0 },
    });
    bw.processEvents();
    bw.drawBackground();
    const clicked = bw.clicked();
    {
        var tl = dvui.textLayout(@src(), .{
            .break_lines = false,
        }, .{
            .background = false,
            .color_text = palette.teal_text,
            .gravity_x = 0.0,
            .gravity_y = 0.5,
            .expand = .horizontal,
            .padding = dvui.Rect.all(0),
        });
        mixed_text.addTextMixed(tl, label, body, .{ .color_text = palette.teal_text });
        tl.deinit();
    }
    bw.drawFocus();
    bw.deinit();
    if (clicked) {
        state.transcript_scroll.viewport.y = state.msg_content_y[slot];
        scroll.clampScrollToContent(&state.transcript_scroll);
    }
}
