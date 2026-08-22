//! Composer chrome — the single-row textEntry field + trailing ▶/■ icon action
//! buttons, extracted to a standalone paint fn (plan #737, source #734) so the
//! dvui testing-backend frame test `composer_layout.test.zig` can drive the
//! REAL surface and lock the width-reservation geometry off actual layout rects.
//! Mirrors the `busy_row.paintBusyRow` extraction contract: no `ui.zig`,
//! `state.zig`, `bridge.zig`, or `composer.zig` dependency for the layout
//! surface — the submit/stop actions are injected as callbacks, so a host test
//! can paint the exact same widget tree the harness emits without Wasm glue.
//!
//! #734 defect: dvui's horizontal-box leftover math honors the field's reported
//! min width *first*. A long unbreakable line (no spaces → `break_lines` can't
//! split it) makes the textEntry report its natural width, so the box allocates
//! that to the field and the trailing ▶/■ icon pack gets leftover ≈ 0 — the
//! icons slide/crush off-canvas before the chrome grows up. Fix: give the field
//! an explicit trailing-*reserved* sub-rect of width `fieldW(avail_w, busy) =
//! avail_w − (n × iconCellW + TE_MARGIN_RIGHT)` so its own reported min width
//! can never push past the reserved icon columns. Plan #782 made `iconCellW`
//! the FULL button footprint (`TOUCH_H + 2·(padding + margin)`), because the
//! reserve counting only `TOUCH_H` per icon let the real tag rects overrun the
//! row and dvui crushed the trailing ■ flush into the right edge at ~390 px.
//! The reserved field wrapper
//! reports exactly that fixed width to the outer box (`max_size_content.w =
//! field_w` clamps its reported min in `WidgetData.minSizeSetAndRefresh`), so
//! the icons always land post-reserve at their full `iconCellW()` cell and
//! never leave the viewport.
//!
//! The wrapper stays a *packed* child: default `gravity.x = 0` is NOT
//! `child_positioned` (BoxWidget only overlays when `gravity.x` is strictly
//! between 0 and 1), so it compacts and removes its width from the row —
//! Strategy A's seam, proven by the layout test's icon x-rects.
const std = @import("std");
const dvui = @import("dvui");
const palette = @import("../palette.zig");
const metrics = @import("metrics.zig");
const chrome = @import("chrome.zig");

/// Right margin on the composer textEntry field (`.margin.w = 8`). Folded into
/// the reserved trailing icon-pack width so the reserve exactly fits
/// `field + margin + icon-footprint×n` and the icons get their full cell.
pub const TE_MARGIN_RIGHT: f32 = 8;

/// Per-side chrome on each trailing ▶/■ button that boxes in the TOUCH_H
/// content square: dvui default ButtonWidget padding (6) + default margin (4).
/// A button's FULL tag-rect width — the thing every goal asserts stays on-canvas
/// ("tag rects include the widget's margin") — is `TOUCH_H + 2·ICON_EDGE_W`,
/// NOT `TOUCH_H`. Plan #782 definite root cause: the pre-#779 reserve counted
/// only `TOUCH_H` per icon, so the real `TOUCH_H + 20` footprint overran the
/// row and dvui's compactor crushed the trailing ■ flush into the right edge at
/// ~390 px (Stop un-hittable). We reserve the FULL footprint and pin the button
/// padding/margin to these constants below so the arithmetic and the widget
/// options can never drift apart.
pub const ICON_PAD: f32 = 6;
pub const ICON_MARGIN: f32 = 4;
/// One side of a button's chrome (padding + margin) added on each edge.
pub const ICON_EDGE_W: f32 = ICON_PAD + ICON_MARGIN;

// id namespace for the composer chrome widgets — never aliases message-loop
// rows or other ui/* widgets (see busy_row.zig / rect_spinner.zig for the same
// high-id pattern).
const FIELD_WRAP_ID: usize = 0x70_0600;
const FIELD_ID: usize = 0x70_0650;
const SEND_ID: usize = 0x70_0700;
const STOP_ID: usize = 0x70_0750;

/// Action callbacks injected by the caller (ui.zig frame). Keeping them out of
/// this module is what lets the host test paint the chrome without `composer`/
/// `bridge` Wasm glue (they'd invoke reload/submit/cancel otherwise).
pub const Actions = struct {
    /// Submit a non-empty field on the ▶ Send click (idle AND this busy row's
    /// enqueue). Invoked only when the field actually holds text.
    on_send: ?*const fn ([]const u8) void = null,
    /// Cancel the in-flight turn on the ■ Stop click (busy only).
    on_stop: ?*const fn () void = null,
    /// Plan #760 — idle ▶ clicked with an EMPTY field + non-empty queue:
    /// promote the queue head (explicit Play). Invoked only when the field is
    /// empty on the idle ▶ (the busy row's ▶ keeps enqueuing typed text). No-op
    /// in the caller when the queue is empty (goal 4). Bridge-free: the caller
    /// binds it to `tryPromoteQueued`.
    on_promote: ?*const fn () void = null,
};

/// What the chrome observed this frame, handed back so `frame()` can keep the
/// dynamic-hug height path and the Enter-chord submit dispatch.
pub const Result = struct {
    /// Current field text (a slice into the caller's `prompt_buf`). Lets
    /// frame() drive the Enter-chord submit / history without this module
    /// owning the composer/submit dispatch.
    typed: []const u8 = "",
    /// Outer height measured via `dvui.minSizeGet(field_id)` AFTER the field
    /// deinit (dvui only reports up during deinit). null when the id has no
    /// stored size this frame (first frame) — frame() falls back to
    /// `composer_last_h` so the band never collapses.
    measured_h: ?f32 = null,
    /// True when the paint consumed a pending focus request (widgets focused).
    focused: bool = false,
};

/// Full footprint of ONE trailing icon button = content square + both-side
/// button chrome (default padding 6 + margin 4 each edge). This is the width
/// that actually lands in the row and which every on-canvas goal measures.
pub fn iconCellW() f32 {
    return metrics.TOUCH_H + 2 * ICON_EDGE_W;
}

/// Width of the trailing icon pack (n = 1 idle, 2 busy) in FULL button
/// footprints — the reserve must cover the real tag rects, not just the
/// TOUCH_H content square (plan #782 root cause).
pub fn iconPackW(busy: bool) f32 {
    return (if (busy) @as(f32, 2) else @as(f32, 1)) * iconCellW();
}

/// Reserved trailing icon-pack width = full button footprints + the field's
/// 8 px right margin. This is what the field must never exceed.
pub fn iconReserveW(busy: bool) f32 {
    return iconPackW(busy) + TE_MARGIN_RIGHT;
}

/// Field width = leftover of the chrome row after the reserved icon pack.
pub fn fieldW(avail_w: f32, busy: bool) f32 {
    return @max(0, avail_w - iconReserveW(busy));
}

/// Paint the composer chrome (field on a trailing-reserved sub-rect + icon
/// buttons) inside the horizontal row at the given absolute y/h. This is what
/// ui.zig frame() emits in place of the old inline L588–788 composer block and
/// what the host layout test drives directly.
pub fn paintComposerChrome(opts: struct {
    busy: bool,
    avail_w: f32,
    y: f32,
    h: f32,
    prompt_buf: []u8,
    want_focus: *bool,
    actions: Actions = .{},
}) Result {
    const src = @src();
    const field_w = fieldW(opts.avail_w, opts.busy);

    var res = Result{};
    {
        var composer_chrome = dvui.box(src, .{ .dir = .horizontal }, .{
            .rect = .{ .x = 0, .y = opts.y, .w = 0, .h = opts.h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_bg,
            .color_border = palette.teal_border,
            .padding = .{ .x = 0, .y = metrics.COMPOSER_HUG_PAD, .w = 0, .h = metrics.COMPOSER_HUG_PAD },
        });
        defer composer_chrome.deinit();

        // ── Field on an explicit trailing-reserved sub-rect (plan #737) ─────
        // The field wrapper reports EXACTLY `field_w` to the outer box
        // (min=max=field_w — max_size_content caps the reported min in
        // WidgetData.minSizeSetAndRefresh), so the box's leftover math can
        // never give the field more than `avail_w − icon_reserve_w` and the
        // icons always land post-reserve at their full cell. The wrapper must stay a
        // PACKED child (gravity.x = 0, not centered) or BoxWidget treats it as
        // an overlay and overlaps the icons instead of compacting.
        {
            var field_wrap = dvui.box(src, .{ .dir = .horizontal }, .{
                .id_extra = FIELD_WRAP_ID,
                .tag = "composer-field-wrap",
                .gravity_y = 0.5,
                .min_size_content = .{ .w = field_w, .h = metrics.TOUCH_H },
                .max_size_content = .{ .w = field_w, .h = dvui.max_float_safe },
                .background = false,
            });
            defer field_wrap.deinit();
            {
                var te = dvui.textEntry(src, .{
                    .text = .{ .buffer = opts.prompt_buf },
                    .placeholder = "Message the model…",
                    .multiline = true,
                    .break_lines = true,
                    .scroll_horizontal = false,
                }, .{
                    .expand = .horizontal,
                    .gravity_y = 0.5,
                    .id_extra = FIELD_ID,
                    .tag = "composer-field",
                    // TE_PAD is baked into min/max by TextEntryWidget.init.
                    // The width MAX is field_w (not max_float_safe), so the
                    // field both wraps at the reserved width and can never
                    // report (or draw) past the icon reserve. min 120 stays a
                    // floor that yields to the field_w cap on narrow widths.
                    .min_size_content = .{ .w = 120, .h = metrics.TOUCH_H - 2 * metrics.COMPOSER_TE_PAD },
                    .max_size_content = .{ .w = field_w, .h = metrics.COMPOSER_INPUT_MAX_H - 2 * metrics.COMPOSER_TE_PAD },
                    .color_fill = palette.teal_surface,
                    .color_text = palette.teal_text,
                    .color_border = if (opts.busy) palette.teal_border else palette.teal_accent,
                    .margin = .{ .x = 0, .y = 0, .w = TE_MARGIN_RIGHT, .h = 0 },
                    .padding = .{ .x = metrics.COMPOSER_TE_PAD, .y = metrics.COMPOSER_TE_PAD, .w = metrics.COMPOSER_TE_PAD, .h = metrics.COMPOSER_TE_PAD },
                    .border = .{ .x = 1, .y = 1, .w = 1, .h = 1 },
                });
                res.typed = te.getText();
                if (opts.want_focus.*) {
                    dvui.focusWidget(te.data().id, null, null);
                    opts.want_focus.* = false;
                    res.focused = true;
                }
                // Capture the field id BEFORE deinit (dvui TextEntryWidget ends
                // in `defer self.* = undefined`) — adversarial #584 discipline.
                const te_id = te.data().id;
                te.deinit();
                res.measured_h = if (dvui.minSizeGet(te_id)) |ms| ms.h else null;
            }
        }

        // ── Trailing icon action buttons (reserved strip, still children of
        // the same row AFTER the field sub-rect; gravity_y=1.0 bottom-pinned,
        // min_size_content TOUCH_H×TOUCH_H — unchanged). ─────────────────────
        if (opts.busy) {
            if (dvui.button(src, "▶", .{}, .{
                .gravity_y = 1.0,
                .id_extra = SEND_ID,
                .tag = "composer-send",
                .style = .highlight,
                .font = chrome.composerIconFont(),
                .min_size_content = .{ .w = metrics.TOUCH_H, .h = metrics.TOUCH_H },
                // Full-footprint reserve (plan #782): pin each button's
                // padding/margin to ICON_PAD/ICON_MARGIN so the trailing icon
                // cell is EXACTLY `TOUCH_H + 2*ICON_EDGE_W` — the same value
                // iconCellW() reserves. Without this the real (default) button
                // footprint overran the reserve and crushed ■ off-canvas.
                .padding = .{ .x = ICON_PAD, .y = ICON_PAD, .w = ICON_PAD, .h = ICON_PAD },
                .margin = .{ .x = ICON_MARGIN, .y = ICON_MARGIN, .w = ICON_MARGIN, .h = ICON_MARGIN },
                .corners = .round(8),
            })) {
                if (res.typed.len > 0) {
                    if (opts.actions.on_send) |cb| cb(res.typed);
                }
            }
            if (dvui.button(src, "■", .{}, .{
                .gravity_y = 1.0,
                .id_extra = STOP_ID,
                .tag = "composer-stop",
                .style = .content,
                .font = chrome.composerIconFont(),
                .min_size_content = .{ .w = metrics.TOUCH_H, .h = metrics.TOUCH_H },
                // Full-footprint reserve (plan #782): pin each button's
                // padding/margin to ICON_PAD/ICON_MARGIN so the trailing icon
                // cell is EXACTLY `TOUCH_H + 2*ICON_EDGE_W` — the same value
                // iconCellW() reserves. Without this the real (default) button
                // footprint overran the reserve and crushed ■ off-canvas.
                .padding = .{ .x = ICON_PAD, .y = ICON_PAD, .w = ICON_PAD, .h = ICON_PAD },
                .margin = .{ .x = ICON_MARGIN, .y = ICON_MARGIN, .w = ICON_MARGIN, .h = ICON_MARGIN },
                .corners = .round(8),
                .color_fill = palette.warm_bg,
                .color_text = palette.warm_accent,
                .color_border = palette.ember_border,
            })) {
                if (opts.actions.on_stop) |cb| cb();
            }
        } else if (dvui.button(src, "▶", .{}, .{
            .gravity_y = 1.0,
            .id_extra = SEND_ID,
            .tag = "composer-send",
            .style = .highlight,
            .font = chrome.composerIconFont(),
            .min_size_content = .{ .w = metrics.TOUCH_H, .h = metrics.TOUCH_H },
            // Full-footprint reserve (plan #782) — see the busy branches: the
            // trailing icon cell is TOUCH_H + 2*ICON_EDGE_W, never TOUCH_H.
            .padding = .{ .x = ICON_PAD, .y = ICON_PAD, .w = ICON_PAD, .h = ICON_PAD },
            .margin = .{ .x = ICON_MARGIN, .y = ICON_MARGIN, .w = ICON_MARGIN, .h = ICON_MARGIN },
            .corners = .round(8),
        })) {
            if (res.typed.len > 0) {
                if (opts.actions.on_send) |cb| cb(res.typed);
            } else if (opts.actions.on_promote) |cb| {
                // Plan #760 — idle ▶ with an EMPTY field falls back to an
                // explicit Play of the queue head (goal 2). The caller no-ops
                // when the queue is empty (goal 4) — no blank row is created.
                cb();
            }
        }
    }
    return res;
}
