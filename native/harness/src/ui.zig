//! Harness product UI (dvui) — Phase 4 Wasm-primary agent workspace.
//! Polish (4.7): density, focus composer, touch targets, scroll stick-to-bottom.
//! #131 / plan #135: persistent transcript ScrollInfo + conditional stick rules.
//! #137 / plan #138: reserved composer chrome; transcript max_size_content so
//! messages cannot cover or starve the input band.
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");

var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

/// First frame after init: focus the composer once.
var want_composer_focus: bool = true;
/// Shown line count last frame (messages + optional busy row).
var last_shown_count: usize = 0;
/// Ring message count last frame (for clear / hydrate / user-send detection).
var last_msg_count: usize = 0;
/// Persistent across frames — frame-local ScrollInfo zeros viewport every paint.
var transcript_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};

const SMOKE_PROMPT = "Reply with exactly: PONG";
/// Cap visible lines for density (ring may hold more).
const VISIBLE_MSG_CAP: usize = 28;
/// Touch-friendly control height (CSS px ≈).
const TOUCH_H: f32 = 40;
/// Near-bottom epsilon for stick-to-bottom follow (plan #135).
const NEAR_BOTTOM_PX: f32 = 48;
/// Reserved bottom chrome: textEntry + action row + margins (plan #138).
/// Height budget: header + this win over transcript min on short canvases.
const COMPOSER_CHROME_MIN: f32 = 2 * TOUCH_H + 20;
/// Default transcript min height when space allows.
const SCROLL_MIN_H: f32 = 120;
/// Absolute floor so a short canvas still has a scroll band.
const SCROLL_FLOOR_H: f32 = 32;

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
    want_composer_focus = true;
    resetTranscriptScroll();
}

fn resetTranscriptScroll() void {
    transcript_scroll = .{
        .vertical = .auto,
        .horizontal = .none,
    };
    last_shown_count = 0;
    last_msg_count = 0;
}

fn isNearBottom(si: *const dvui.ScrollInfo) bool {
    return si.offsetFromMax(.vertical) <= NEAR_BOTTOM_PX;
}

fn clampScrollToContent(si: *dvui.ScrollInfo) void {
    const max_y = si.scrollMax(.vertical);
    if (si.viewport.y > max_y) si.viewport.y = max_y;
    if (si.viewport.y < 0) si.viewport.y = 0;
}

fn scrollToBottom(si: *dvui.ScrollInfo) void {
    si.viewport.y = si.scrollMax(.vertical);
}

pub fn onDeinit() void {}

fn kindLabel(kind: u8) []const u8 {
    return switch (kind) {
        1 => "you",
        2 => "assistant",
        3 => "system",
        4 => "error",
        else => "msg",
    };
}

fn lifecycleLabel(l: bridge.Lifecycle) []const u8 {
    return switch (l) {
        .boot => "boot",
        .ready => "ready",
        .busy => "busy",
        .err => "error",
    };
}

fn kindTextColor(kind: u8) dvui.Color {
    return switch (kind) {
        1 => palette.teal_accent,
        2 => palette.warm_accent,
        3 => palette.teal_muted,
        4 => palette.ember_accent,
        else => palette.teal_text,
    };
}

fn kindFill(kind: u8) ?dvui.Color {
    return switch (kind) {
        1 => palette.teal_bg,
        2 => palette.teal_surface,
        3 => null,
        4 => palette.ember_surface,
        else => null,
    };
}

fn clearPrompt() void {
    @memset(&prompt_buf, 0);
}

fn submitText(text: []const u8) void {
    bridge.queueSubmitFromUi(text);
    clearPrompt();
}

pub fn frame() !void {
    const life = bridge.getLifecycle();
    const busy = life == .busy;

    // Full-bleed root (tight padding so ~390px still usable).
    var root = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .both,
        .background = true,
        .style = .window,
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_text,
        .color_border = palette.teal_border,
        .padding = .all(8),
    });
    defer root.deinit();

    const root_content_h = root.data().contentRect().h;

    // ── Header (compact) ──────────────────────────────────────────────────
    var header_h: f32 = TOUCH_H + 28;
    {
        var head = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .padding = .{ .x = 10, .y = 8, .w = 10, .h = 8 },
            .margin = .{ .x = 0, .y = 0, .w = 0, .h = 6 },
            .min_size_content = .{ .w = 0, .h = TOUCH_H },
        });
        defer {
            header_h = head.data().rect.h;
            head.deinit();
        }

        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .font = .theme(.heading),
                .color_text = palette.teal_text,
                .gravity_y = 0.5,
            });
            tl.addText("Agent harness", .{});
            tl.deinit();
        }
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .color_text = if (busy) palette.warm_accent else palette.teal_muted,
                .gravity_y = 0.5,
            });
            tl.format("{s}", .{lifecycleLabel(life)}, .{});
            tl.deinit();
        }
        // Protocol v3: cycle through granted models (host pushed catalog).
        {
            const cat_n = bridge.modelCatalogCount();
            {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .color_text = if (cat_n == 0) palette.teal_muted else palette.teal_accent,
                    .gravity_y = 0.5,
                    .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                });
                if (cat_n == 0) {
                    tl.addText("no model", .{});
                } else {
                    tl.format("{s}", .{bridge.selectedModelLabel()}, .{});
                }
                tl.deinit();
            }
            if (cat_n > 1) {
                if (dvui.button(@src(), "Next", .{}, .{
                    .gravity_y = 0.5,
                    .style = .content,
                    .min_size_content = .{ .w = 52, .h = TOUCH_H - 8 },
                    .corners = .round(6),
                    .color_fill = palette.teal_bg,
                    .color_text = palette.teal_accent,
                    .color_border = palette.teal_border,
                    .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                })) {
                    if (!busy) {
                        bridge.cycleSelectedModel();
                    }
                }
            }
        }
    }

    // Transcript layout height: leftover after header + reserved composer chrome.
    // max_size_content caps content-driven min so the scroller cannot starve chrome
    // (dvui Options: use when scrollArea makes the parent too big).
    const scroll_h_max = @max(SCROLL_FLOOR_H, root_content_h - header_h - COMPOSER_CHROME_MIN);
    const scroll_min_h = @min(SCROLL_MIN_H, scroll_h_max);

    // ── Transcript ────────────────────────────────────────────────────────
    // near_before uses last frame's virtual_size (still valid before this layout).
    // Stick/clamp runs AFTER scrollArea.deinit so scrollMax sees this frame's size
    // (dvui writes virtual_size in ScrollContainer.deinit — see dvui scrolling example).
    const near_before = isNearBottom(&transcript_scroll);
    const prev_msg = last_msg_count;
    const prev_shown = last_shown_count;
    const n = bridge.messageCount();
    const shown = n + @as(usize, if (busy) 1 else 0);
    var user_scroll: dvui.Point = .{};
    {
        var scroll = dvui.scrollArea(@src(), .{
            .scroll_info = &transcript_scroll,
            .vertical_bar = .auto,
            .user_scroll = &user_scroll,
        }, .{
            .expand = .both,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = scroll_min_h },
            // Cap layout min so tall message content cannot push past remaining height.
            .max_size_content = .height(scroll_h_max),
            .padding = .all(8),
            .margin = .{ .x = 0, .y = 0, .w = 0, .h = 6 },
        });
        defer scroll.deinit();

        var body = dvui.box(@src(), .{ .dir = .vertical }, .{
            .expand = .horizontal,
        });
        defer body.deinit();
        if (n == 0) {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .color_text = palette.teal_muted,
            });
            if (bridge.modelCatalogCount() == 0) {
                tl.addText(
                    "No models available\n\nAsk a tenant admin to grant you an inference key,\nor wait for the host catalog to load.\n",
                    .{},
                );
            } else {
                tl.addText(
                    "Start a conversation\n\nType below, then Enter or Send.\nUse Next in the header to cycle models.\n",
                    .{},
                );
            }
            tl.deinit();
        } else {
            // Density: only paint the last VISIBLE_MSG_CAP lines.
            const start: usize = if (n > VISIBLE_MSG_CAP) n - VISIBLE_MSG_CAP else 0;
            if (start > 0) {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .expand = .horizontal,
                    .color_text = palette.teal_muted,
                    .id_extra = 0xffff_fffe,
                });
                tl.format("… {d} earlier messages\n", .{start}, .{});
                tl.deinit();
            }
            var i: usize = start;
            while (i < n) : (i += 1) {
                if (bridge.messageAt(i)) |m| {
                    const is_err = m.kind == 4;
                    var row = dvui.box(@src(), .{ .dir = .vertical }, .{
                        .expand = .horizontal,
                        .id_extra = i,
                        .background = kindFill(m.kind) != null,
                        .color_fill = kindFill(m.kind),
                        .color_border = if (is_err) palette.ember_border else palette.teal_border,
                        .padding = .{ .x = 8, .y = 6, .w = 8, .h = 6 },
                        .margin = .{ .x = 0, .y = 0, .w = 0, .h = 4 },
                        .style = if (is_err) .err else .content,
                    });
                    defer row.deinit();

                    {
                        var tl = dvui.textLayout(@src(), .{}, .{
                            .expand = .horizontal,
                            .id_extra = i * 2,
                            .color_text = kindTextColor(m.kind),
                            .font = .theme(.heading),
                        });
                        tl.format("{s}", .{kindLabel(m.kind)}, .{});
                        tl.deinit();
                    }
                    {
                        var tl = dvui.textLayout(@src(), .{}, .{
                            .expand = .horizontal,
                            .id_extra = i * 2 + 1,
                            .color_text = if (is_err) palette.ember_text else palette.teal_text,
                        });
                        tl.format("{s}", .{m.text}, .{});
                        tl.deinit();
                    }
                }
            }
        }

        if (busy) {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .color_text = palette.warm_accent,
                .id_extra = 0xffff_ffff,
            });
            tl.addText("Waiting for model…", .{});
            tl.deinit();
        }
    }

    // Conditional stick-to-bottom (plan #135 / #131) — after deinit so virtual_size is current.
    if (n < prev_msg) {
        // Clear or ring shrink: land at bottom of new content.
        transcript_scroll.velocity = .{ .x = 0, .y = 0 };
        scrollToBottom(&transcript_scroll);
        last_shown_count = shown;
        last_msg_count = n;
    } else if (shown != prev_shown) {
        // User-kind follow without requiring msg_count growth (ring full overwrites).
        // Require shown growth so busy-row collapse alone does not re-yank while scrolled up.
        const newest_is_user = blk: {
            if (n == 0) break :blk false;
            if (bridge.messageAt(n - 1)) |m| break :blk m.kind == @intFromEnum(bridge.MessageKind.user);
            break :blk false;
        };
        const user_sent = newest_is_user and shown > prev_shown;
        // Hydrate / batch: empty→many, or ≥3 messages in one frame (batched push).
        const hydrate = (prev_msg == 0 and n > 1) or (n >= prev_msg + 3);
        // user_scroll.y < 0 → user moved toward older content this frame (dvui convention).
        const should_follow = user_sent or hydrate or prev_msg == 0 or (near_before and user_scroll.y >= 0);
        if (should_follow) {
            scrollToBottom(&transcript_scroll);
        } else {
            clampScrollToContent(&transcript_scroll);
        }
        last_shown_count = shown;
        last_msg_count = n;
    } else {
        clampScrollToContent(&transcript_scroll);
    }

    // ── Composer chrome (outside scrollArea — plan #138) ──────────────────
    // Solid fill so tall transcript paint cannot show through; no vertical expand
    // so chrome keeps COMPOSER_CHROME_MIN and stays on-canvas.
    var typed: []const u8 = prompt_buf[0..0];
    {
        var chrome = dvui.box(@src(), .{ .dir = .vertical }, .{
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_bg,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = COMPOSER_CHROME_MIN },
            .padding = .{ .x = 0, .y = 4, .w = 0, .h = 0 },
        });
        defer chrome.deinit();

        // Single-line so Enter submits — multiline disables enter_pressed.
        {
            var te = dvui.textEntry(@src(), .{
                .text = .{ .buffer = prompt_buf[0..] },
                .placeholder = "Message the model…",
                .multiline = false,
            }, .{
                .expand = .horizontal,
                .min_size_content = .{ .w = 120, .h = TOUCH_H },
                .color_fill = palette.teal_surface,
                .color_text = palette.teal_text,
                .color_border = if (busy) palette.teal_border else palette.teal_accent,
                .margin = .{ .x = 0, .y = 0, .w = 0, .h = 6 },
            });
            typed = te.getText();
            if (want_composer_focus) {
                dvui.focusWidget(te.data().id, null, null);
                want_composer_focus = false;
            }
            const enter = te.enter_pressed and !busy;
            te.deinit();
            if (enter and typed.len > 0) {
                submitText(typed);
                typed = prompt_buf[0..0];
                // Re-focus next frame after submit
                want_composer_focus = true;
            }
        }

        // Actions (large hit targets)
        {
            var row = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .min_size_content = .{ .w = 0, .h = TOUCH_H + 4 },
            });
            defer row.deinit();

            if (dvui.button(@src(), "Send", .{}, .{
                .gravity_y = 0.5,
                .style = .highlight,
                .min_size_content = .{ .w = 72, .h = TOUCH_H },
                .corners = .round(8),
            })) {
                if (!busy and typed.len > 0) {
                    submitText(typed);
                    want_composer_focus = true;
                }
            }
            if (dvui.button(@src(), "PONG", .{}, .{
                .gravity_y = 0.5,
                .style = .app1,
                .min_size_content = .{ .w = 72, .h = TOUCH_H },
                .corners = .round(8),
                .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
            })) {
                if (!busy) {
                    submitText(SMOKE_PROMPT);
                    want_composer_focus = true;
                }
            }
            {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .gravity_y = 0.5,
                    .color_text = palette.teal_muted,
                    .margin = .{ .x = 10, .y = 0, .w = 0, .h = 0 },
                });
                if (busy) {
                    tl.addText("busy…", .{});
                } else {
                    tl.addText("Enter to send", .{});
                }
                tl.deinit();
            }
        }
    }
}
