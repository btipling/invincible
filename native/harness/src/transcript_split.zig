//! Collapsible left rail inside the transcript band (canvas top → composer).
//! Standalone on purpose (no `ui.zig` / `bridge`) so the host dvui
//! testing-backend test `transcript_split_layout.test.zig` can paint the same
//! chrome the harness emits and assert closed/open widths off real layout rects.
//!
//! `ui.zig` `frame()` owns band math (`scroll_y` / `scroll_h`) and passes those
//! into `paint`. The rail is a sibling `Options.rect` of the transcript
//! `scrollArea` — it does not participate in root flex, and it does not wrap
//! the scroller (the scroller keeps its own rect so the `.auto` bar cannot
//! publish virtual content height into the root).
//!
//! Default closed: thin icon strip (`SIDEBAR_RAIL_W` = 40, same as `TOUCH_H`).
//! Open: `teal_surface` column (`SIDEBAR_OPEN_W` = 220) with the session list
//! (host-pushed catalog). Toggle glyphs use `palette.fontSymbols()` (DejaVu).
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("palette.zig");
const session_catalog = @import("session_catalog.zig");

/// Closed rail width (px) — one touch target, matches `ui.zig` `TOUCH_H`.
pub const SIDEBAR_RAIL_W: f32 = 40;
/// Open column width (px). Session list scrolls inside this width.
pub const SIDEBAR_OPEN_W: f32 = 220;
/// Toggle / row hit target (px) — same as the closed rail and composer Send/Stop.
pub const TOUCH_H: f32 = SIDEBAR_RAIL_W;

/// In-memory open/closed. Default closed. `reset` on harness `onInit`.
var sidebar_open: bool = false;

/// Dedicated id extras — never share the message-loop / busy-row namespaces.
const RAIL_ID: usize = 0x61_0000;
const TOGGLE_ID: usize = 0x61_0010;
const LIST_ID: usize = 0x61_0020;
const ROW_ID: usize = 0x61_1000;

/// Closed **U+25B8 ▸** (open the rail). Not U+25B6 ▶ (composer Send).
const GLYPH_CLOSED: []const u8 = "\u{25B8}";
/// Open **U+25C2 ◂** (collapse the rail).
const GLYPH_OPEN: []const u8 = "\u{25C2}";

pub fn reset() void {
    sidebar_open = false;
}

pub fn isOpen() bool {
    return sidebar_open;
}

/// Test / operator seam — layout tests flip this instead of synthesizing a click.
pub fn setOpen(open: bool) void {
    sidebar_open = open;
}

pub fn paneWidthOf(open: bool) f32 {
    return if (open) SIDEBAR_OPEN_W else SIDEBAR_RAIL_W;
}

pub fn paneWidth() f32 {
    return paneWidthOf(sidebar_open);
}

fn toggleFont() dvui.Font {
    const body = dvui.Font.theme(.body);
    return palette.fontSymbols()
        .withSize(body.size + 4)
        .withLineHeight(1.0);
}

fn rowFont() dvui.Font {
    const body = dvui.Font.theme(.body);
    return body.withSize(body.size).withLineHeight(1.0);
}

/// Paint the rail as an absolute rect in the transcript band.
/// `band_y` / `band_h` are the same `scroll_y` / `scroll_h` the scroller uses.
pub fn paint(band_y: f32, band_h: f32) void {
    const w = paneWidth();
    const src = @src();
    var rail = dvui.box(src, .{ .dir = .vertical }, .{
        .rect = .{ .x = 0, .y = band_y, .w = w, .h = band_h },
        .background = true,
        .color_fill = palette.teal_surface,
        .color_border = palette.teal_border,
        .border = .{ .x = 0, .y = 0, .w = 1, .h = 0 },
        .padding = .all(0),
        .tag = "transcript-rail",
        .id_extra = RAIL_ID,
        .min_size_content = .{ .w = w, .h = band_h },
        .max_size_content = .{ .w = w, .h = band_h },
    });
    defer rail.deinit();

    const glyph = if (sidebar_open) GLYPH_OPEN else GLYPH_CLOSED;
    if (dvui.button(src, glyph, .{}, .{
        .font = toggleFont(),
        .style = .content,
        .min_size_content = .{ .w = TOUCH_H, .h = TOUCH_H },
        .max_size_content = .{ .w = TOUCH_H, .h = TOUCH_H },
        .corners = .round(8),
        .color_fill = palette.teal_surface,
        .color_text = palette.teal_accent,
        .color_border = palette.teal_border,
        .margin = .all(0),
        .padding = .all(0),
        .border = .all(0),
        .tag = "transcript-rail-toggle",
        .id_extra = TOGGLE_ID,
    })) {
        sidebar_open = !sidebar_open;
    }

    if (!sidebar_open) return;

    const list_h = @max(0, band_h - TOUCH_H);
    var scroll = dvui.scrollArea(src, .{
        .vertical_bar = .auto,
        .horizontal_bar = .hide,
    }, .{
        .expand = .both,
        .background = false,
        .padding = .all(0),
        .border = .all(0),
        .min_size_content = .{ .w = w - 1, .h = list_h },
        .max_size_content = .{ .w = w - 1, .h = list_h },
        .tag = "transcript-rail-list",
        .id_extra = LIST_ID,
    });
    defer scroll.deinit();

    var i: u32 = 0;
    const n = session_catalog.catalogCount();
    while (i < n) : (i += 1) {
        const selected = if (session_catalog.currentIndex()) |cur| cur == i else false;
        var tag_buf: [40]u8 = undefined;
        const tag = std.fmt.bufPrint(&tag_buf, "transcript-rail-row-{d}", .{i}) catch "transcript-rail-row";
        if (dvui.button(src, session_catalog.labelAt(i), .{}, .{
            .font = rowFont(),
            .style = .content,
            .expand = .horizontal,
            .min_size_content = .{ .w = w - 1, .h = TOUCH_H },
            .max_size_content = .{ .h = TOUCH_H },
            .corners = .round(0),
            .color_fill = palette.teal_surface,
            .color_text = if (selected) palette.teal_accent else palette.teal_text,
            .color_fill_hover = palette.teal_border,
            .color_text_hover = palette.teal_accent,
            .color_border = palette.teal_border,
            .margin = .all(0),
            .padding = .{ .x = 8, .y = 0, .w = 8, .h = 0 },
            .border = .all(0),
            .tag = tag,
            .id_extra = ROW_ID + i,
        })) {
            _ = session_catalog.requestSwitch(i);
        }
    }
}
