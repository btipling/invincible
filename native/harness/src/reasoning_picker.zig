//! Status-bar reasoning-effort picker — stock dvui menu, TEAL tokens (plan #898).
//! Hidden when the current model has no Gateway effort values.
//! Isolated so `reasoning_picker_layout.test.zig` can paint under the host
//! testing backend without `bridge` / wasm refresh.
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("palette.zig");
const reasoning_catalog = @import("reasoning_catalog.zig");

/// Trigger height (px) — same as the model picker so line 1 stays 32.
pub const PICKER_TRIGGER_H: f32 = 32;
/// Menu-item height (px) inside the floating panel.
pub const PICKER_ITEM_H: f32 = 32;

/// Closed **U+25BE ▾** — Geometric Shapes; paint with `fontSymbols()` only.
const GLYPH_CHEVRON: []const u8 = "\u{25BE}";
/// Left margin on the caret run (px) — the declared gap between label and ▾.
pub const CARET_GAP: f32 = 4;

/// Dedicated extras — sit next to the model picker's `0x62_0000` namespace.
const TRIGGER_ID: usize = 0x62_0100;
const MENU_ID: usize = 0x62_0110;

pub fn chevronFont() dvui.Font {
    return palette.fontSymbols();
}

pub const CatalogView = struct {
    count: u32,
    selected: u32,
    busy: bool,
    /// False when the host has not committed a selection (never-auto lists
    /// such as max-only). Static count==1 would make that value unlistable.
    has_selection: bool,
    short_label: []const u8,
    idAt: *const fn (index: u32) []const u8,
};

/// Paint the trigger (and menu when open). Returns the picked catalog index,
/// or null when nothing was committed this frame. Count 0 → hidden (no paint).
/// Count 1 with a committed selection → static (no menu). Count 1 unset →
/// menu so the operator can commit a NEVER_AUTO-only value (plan #898: max
/// is listable).
pub fn paint(view: CatalogView) ?u32 {
    if (view.count == 0) return null;
    if (view.count == 1 and view.has_selection) {
        paintStaticTrigger(view);
        return null;
    }
    return paintMenuTrigger(view);
}

fn paintStaticTrigger(view: CatalogView) void {
    var box = dvui.box(@src(), .{ .dir = .horizontal }, .{
        .tag = "status-effort-trigger",
        .id_extra = TRIGGER_ID,
        .gravity_y = 0.5,
        .min_size_content = .{ .h = PICKER_TRIGGER_H },
        .padding = .{ .x = 4, .y = 0, .w = 4, .h = 0 },
        .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
        .background = false,
    });
    defer box.deinit();
    dvui.labelNoFmt(@src(), view.short_label, .{}, .{
        .color_text = palette.teal_accent,
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
        .tag = "status-effort-trigger",
        .id_extra = TRIGGER_ID + 1,
        .gravity_y = 0.5,
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
    var row = dvui.box(@src(), .{ .dir = .horizontal }, .{
        .gravity_y = 0.5,
        .background = false,
    });
    dvui.labelNoFmt(@src(), view.short_label, .{}, .{
        .color_text = palette.teal_accent,
        .gravity_y = 0.5,
        .tag = "status-effort-label",
        .id_extra = TRIGGER_ID + 2,
    });
    if (reasoning_catalog.showChevron(view.count)) {
        dvui.labelNoFmt(@src(), GLYPH_CHEVRON, .{}, .{
            .font = chevronFont(),
            .color_text = palette.teal_accent,
            .gravity_y = 0.5,
            .margin = .{ .x = CARET_GAP, .y = 0, .w = 0, .h = 0 },
            .tag = "status-effort-caret",
            .id_extra = TRIGGER_ID + 3,
        });
    }
    row.deinit();
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
            const item_tag = std.fmt.bufPrint(&item_tag_buf, "status-effort-item-{d}", .{i}) catch "status-effort-item";
            if (dvui.menuItemLabel(@src(), id, .{}, .{
                .tag = item_tag,
                .id_extra = i,
                .expand = .horizontal,
                .min_size_content = .{ .h = PICKER_ITEM_H },
                .padding = .{ .x = 8, .y = 4, .w = 8, .h = 4 },
                .color_fill = if (selected) palette.teal_border else palette.teal_surface,
                .color_text = if (selected) palette.teal_accent else palette.teal_text,
                .color_fill_hover = palette.teal_border,
                .color_text_hover = palette.teal_accent,
                .style = .content,
            }) != null) {
                if (reasoning_catalog.canCommit(view.busy)) picked = i;
                fw.close();
            }
        }
    }
    return picked;
}
