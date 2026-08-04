//! Harness product UI (dvui) — Phase 4 Wasm-primary agent workspace.
//! Polish (4.7): density, focus composer, touch targets, scroll stick-to-bottom.
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");

var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

/// First frame after init: focus the composer once.
var want_composer_focus: bool = true;
/// Stick transcript scroll to bottom when message count grows.
var last_shown_count: usize = 0;

const SMOKE_PROMPT = "Reply with exactly: PONG";
/// Cap visible lines for density (ring may hold more).
const VISIBLE_MSG_CAP: usize = 28;
/// Touch-friendly control height (CSS px ≈).
const TOUCH_H: f32 = 40;

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
    want_composer_focus = true;
    last_shown_count = 0;
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

    // ── Header (compact) ──────────────────────────────────────────────────
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
        defer head.deinit();

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

    // ── Transcript ────────────────────────────────────────────────────────
    var scroll_info: dvui.ScrollInfo = .{
        .vertical = .auto,
        .horizontal = .none,
    };
    {
        var scroll = dvui.scrollArea(@src(), .{
            .scroll_info = &scroll_info,
            .vertical_bar = .auto,
        }, .{
            .expand = .both,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = 120 },
            .padding = .all(8),
            .margin = .{ .x = 0, .y = 0, .w = 0, .h = 6 },
        });
        defer scroll.deinit();

        var body = dvui.box(@src(), .{ .dir = .vertical }, .{
            .expand = .horizontal,
        });
        defer body.deinit();

        const n = bridge.messageCount();
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

        // Stick to bottom when new messages arrive (or busy line appears).
        const shown = n + @as(usize, if (busy) 1 else 0);
        if (shown != last_shown_count) {
            last_shown_count = shown;
            scroll_info.viewport.y = scroll_info.scrollMax(.vertical);
        }
    }

    // ── Composer (single-line so Enter submits — multiline disables enter_pressed) ──
    var typed: []const u8 = prompt_buf[0..0];
    {
        var te = dvui.textEntry(@src(), .{
            .text = .{ .buffer = prompt_buf[0..] },
            .placeholder = "Message the model…",
            .multiline = false,
        }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 120, .h = TOUCH_H },
            .color_fill = palette.teal_bg,
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

    // ── Actions (large hit targets) ───────────────────────────────────────
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
