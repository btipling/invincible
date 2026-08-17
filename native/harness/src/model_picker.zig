//! Status-bar model picker — stock dvui menu, TEAL tokens, no protocol.
//! Isolated so `model_picker_layout.test.zig` can paint the trigger under the
//! host testing backend without `bridge` / wasm refresh.
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("palette.zig");
const model_catalog = @import("model_catalog.zig");

/// Trigger height (px) — same as today's Next (`TOUCH_H - 8`) so line 1 stays 32.
pub const PICKER_TRIGGER_H: f32 = 32;
/// Menu-item height (px) inside the floating panel.
pub const PICKER_ITEM_H: f32 = 32;

/// Closed **U+25BE ▾** — Geometric Shapes; paint with `fontSymbols()` only.
const GLYPH_CHEVRON: []const u8 = "\u{25BE}";

/// Dedicated extras — never reuse the `0x61_*` rail / slot / bar namespace.
const TRIGGER_ID: usize = 0x62_0000;
const MENU_ID: usize = 0x62_0010;

pub const CatalogView = struct {
    count: u32,
    selected: u32,
    busy: bool,
    short_label: []const u8,
    idAt: *const fn (index: u32) []const u8,
};

/// Paint the trigger (and menu when open). Returns the picked catalog index,
/// or null when nothing was committed this frame.
pub fn paint(view: CatalogView) ?u32 {
    if (view.count <= 1) {
        paintStaticTrigger(view);
        return null;
    }
    return paintMenuTrigger(view);
}

fn paintStaticTrigger(view: CatalogView) void {
    const empty = view.count == 0;
    var box = dvui.box(@src(), .{ .dir = .horizontal }, .{
        .tag = "status-model-trigger",
        .id_extra = TRIGGER_ID,
        .gravity_y = 0.5,
        .min_size_content = .{ .h = PICKER_TRIGGER_H },
        .padding = .{ .x = 4, .y = 0, .w = 4, .h = 0 },
        .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
        .background = false,
    });
    defer box.deinit();
    const text = if (empty) "no model" else view.short_label;
    dvui.labelNoFmt(@src(), text, .{}, .{
        .color_text = if (empty) palette.teal_muted else palette.teal_accent,
        .gravity_y = 0.5,
    });
}

fn paintMenuTrigger(view: CatalogView) ?u32 {
    var picked: ?u32 = null;
    var m = dvui.menu(@src(), .horizontal, .{
        .padding = .all(0),
        .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
        .background = false,
        .id_extra = TRIGGER_ID,
    });
    defer m.deinit();

    var mi = dvui.menuItem(@src(), .{ .submenu = true }, .{
        .tag = "status-model-trigger",
        .id_extra = TRIGGER_ID + 1,
        .gravity_y = 0.5,
        // Border bakes into outer height (same class as COMPOSER_TE_PAD).
        // 32 − 2×1 = 30 content so the tagged rect stays PICKER_TRIGGER_H.
        .min_size_content = .{ .h = PICKER_TRIGGER_H - 2 },
        .padding = .{ .x = 4, .y = 0, .w = 4, .h = 0 },
        .margin = .all(0),
        .border = .all(1),
        .corners = .round(6),
        .color_fill = palette.teal_surface,
        .color_text = palette.teal_accent,
        .color_border = palette.teal_accent,
        .style = .content,
    });
    dvui.labelNoFmt(@src(), view.short_label, .{}, .{
        .color_text = palette.teal_accent,
        .gravity_y = 0.5,
    });
    if (model_catalog.showChevron(view.count)) {
        dvui.labelNoFmt(@src(), GLYPH_CHEVRON, .{}, .{
            .font = palette.fontSymbols(),
            .color_text = palette.teal_accent,
            .gravity_y = 0.5,
            .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
        });
    }
    const maybe_r = mi.activeRect();
    mi.deinit();

    if (maybe_r) |r| {
        var fw = dvui.floatingMenu(@src(), .{ .from = r, .avoid = .vertical }, .{
            .id_extra = MENU_ID,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_text = palette.teal_text,
            .color_border = palette.teal_border,
            .border = .all(1),
            .style = .content,
        });
        defer fw.deinit();
        var i: u32 = 0;
        while (i < view.count) : (i += 1) {
            const id = view.idAt(i);
            const selected = i == view.selected;
            var item_tag_buf: [48]u8 = undefined;
            const item_tag = std.fmt.bufPrint(&item_tag_buf, "status-model-item-{d}", .{i}) catch "status-model-item";
            if (dvui.menuItemLabel(@src(), id, .{}, .{
                .tag = item_tag,
                .id_extra = i,
                .expand = .horizontal,
                .min_size_content = .{ .h = PICKER_ITEM_H },
                .padding = .{ .x = 8, .y = 4, .w = 8, .h = 4 },
                .color_fill = if (selected) palette.teal_border else palette.teal_surface,
                .color_text = if (selected) palette.teal_accent else palette.teal_text,
                // Plan lock (test row 11): hover = teal_border fill + teal_accent text,
                // so an idle row under the pointer reads exactly like the selected row.
                .color_fill_hover = palette.teal_border,
                .color_text_hover = palette.teal_accent,
                .style = .content,
            }) != null) {
                if (model_catalog.canCommit(view.busy)) picked = i;
                fw.close();
            }
        }
    }
    return picked;
}
