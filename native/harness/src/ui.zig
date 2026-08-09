//! Harness product UI (dvui) — Phase 4 Wasm-primary agent workspace.
//! Polish (4.7): density, focus composer, touch targets, scroll stick-to-bottom.
//! #131 / plan #135: persistent transcript ScrollInfo + conditional stick rules.
//! #251: stick also on in-place stream growth (update_last / content height).
//! #137: IMGUI absolute-rect bands (header / transcript / composer) so content
//! min-size cannot push chrome off-canvas. Build id (`h:…`) detects stale wasm.
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");
const build_options = @import("build_options");
const rich = @import("rich/root.zig");
const mixed_text = @import("rich/mixed_text.zig");

/// Baked at compile time (`-Dbuild-id=…`); shown in header to detect stale wasm.
pub const BUILD_ID: []const u8 = build_options.build_id;

var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

/// First frame after init: focus the composer once.
var want_composer_focus: bool = true;
/// Shown line count last frame (messages + optional busy row).
var last_shown_count: usize = 0;
/// Ring message count last frame (for clear / hydrate / user-send detection).
var last_msg_count: usize = 0;
/// Virtual content scrollMax from last frame — stream growth detection (#251).
var last_scroll_max_y: f32 = 0;
/// Persistent across frames — frame-local ScrollInfo zeros viewport every paint.
var transcript_scroll: dvui.ScrollInfo = .{
    .vertical = .auto,
    .horizontal = .none,
};

const SMOKE_PROMPT = "Reply with exactly: PONG";
/// Touch-friendly control height (CSS px ≈).
const TOUCH_H: f32 = 40;
/// Near-bottom epsilon for stick-to-bottom follow (plan #135).
const NEAR_BOTTOM_PX: f32 = 48;
/// Ignore subpixel layout noise when detecting in-place stream growth (#251).
const CONTENT_GREW_EPS: f32 = 1.0;
/// Reserved bottom chrome: textEntry + action row + margins (plan #138).
/// Height budget: header + this win over transcript min on short canvases.
const COMPOSER_CHROME_MIN: f32 = 2 * TOUCH_H + 20;
/// Chrome box top padding (Options.padding.y) — outside min_size_content.
const COMPOSER_PAD_Y: f32 = 4;
/// Vertical margins between header→scroll and scroll→chrome (Options.margin.h).
const BAND_GAP: f32 = 6;
/// Absolute floor so a short canvas still has a scroll band.
const SCROLL_FLOOR_H: f32 = 32;

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
    want_composer_focus = true;
    resetTranscriptScroll();
    rich.clearCache();
}

fn resetTranscriptScroll() void {
    transcript_scroll = .{
        .vertical = .auto,
        .horizontal = .none,
    };
    last_shown_count = 0;
    last_msg_count = 0;
    last_scroll_max_y = 0;
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
        5 => "thinking",
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
        // Muted warm — thinking monologue (not EMBER, not pure blue).
        5 => palette.warm_muted,
        else => palette.teal_text,
    };
}

fn kindFill(kind: u8) ?dvui.Color {
    return switch (kind) {
        1 => palette.teal_bg,
        2 => palette.teal_surface,
        3 => null,
        4 => palette.ember_surface,
        5 => palette.warm_bg,
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

    // Full-bleed root. Children that use Options.rect do not report min-size up
    // the tree (WidgetData.minSizeReportToParent) — required so tall transcript
    // content cannot push the composer off-canvas.
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

    // Viewport in parent content coords (IMGUI: recompute every frame).
    var avail = root.data().contentRect().justSize();
    if (avail.h < 1 or avail.w < 1) {
        const wr = dvui.windowRect();
        avail = .{ .x = 0, .y = 0, .w = @max(1, wr.w - 16), .h = @max(1, wr.h - 16) };
    }

    // Fixed chrome height (content + pad). Header uses a measured estimate then
    // absolute placement so bands never depend on expand packing order.
    const chrome_h: f32 = COMPOSER_CHROME_MIN + COMPOSER_PAD_Y;
    // Header band: title row ~ TOUCH_H + padding/margin.
    const header_h: f32 = TOUCH_H + 24;
    const scroll_y = header_h + BAND_GAP;
    const scroll_h = @max(SCROLL_FLOOR_H, avail.h - scroll_y - chrome_h - BAND_GAP);
    const chrome_y = avail.h - chrome_h;

    // ── Header (absolute top band) ────────────────────────────────────────
    {
        var head = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .rect = .{ .x = 0, .y = 0, .w = 0, .h = header_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .padding = .{ .x = 10, .y = 6, .w = 10, .h = 6 },
            .min_size_content = .{ .w = 0, .h = TOUCH_H - 8 },
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
        // Build id — proves which wasm is running (stale-cache detector).
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .color_text = palette.teal_muted,
                .gravity_y = 0.5,
                .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
            });
            tl.format("h:{s}", .{BUILD_ID}, .{});
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

    // ── Transcript (absolute middle band — fixed pixel height) ────────────
    const near_before = isNearBottom(&transcript_scroll);
    const prev_msg = last_msg_count;
    const prev_shown = last_shown_count;
    const n = bridge.messageCount();
    const shown = n + @as(usize, if (busy) 1 else 0);
    var user_scroll: dvui.Point = .{};
    {
        // Content height = band minus vertical padding (all 8 → 16).
        const scroll_pad_v: f32 = 16;
        const scroll_content_h = @max(SCROLL_FLOOR_H, scroll_h - scroll_pad_v);
        var scroll = dvui.scrollArea(@src(), .{
            .scroll_info = &transcript_scroll,
            .vertical_bar = .auto,
            .user_scroll = &user_scroll,
        }, .{
            .rect = .{ .x = 0, .y = scroll_y, .w = 0, .h = scroll_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = scroll_content_h },
            .max_size_content = .height(scroll_content_h),
            .padding = .all(8),
        });
        defer scroll.deinit();

        var body = dvui.box(@src(), .{ .dir = .vertical }, .{
            .expand = .horizontal,
        });
        defer body.deinit();

        // Protocol v6: host sets can_load_earlier when SessionStore has older turns.
        if (bridge.canLoadEarlier()) {
            if (dvui.button(@src(), "Load earlier", .{}, .{
                .expand = .horizontal,
                .style = .content,
                .min_size_content = .{ .w = 120, .h = TOUCH_H - 4 },
                .corners = .round(6),
                .color_fill = palette.teal_bg,
                .color_text = palette.teal_accent,
                .color_border = palette.teal_border,
                .margin = .{ .x = 0, .y = 0, .w = 0, .h = 8 },
                .id_extra = 0xffff_fffd,
            })) {
                if (!busy) bridge.queueLoadEarlierFromUi();
            }
        }

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
            // Paint entire in-ring transcript (MAX_MSG=512). No paint-cap / earlier hint.
            var i: usize = 0;
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

                    // Kind label + Copy (message source → system clipboard).
                    // id_extra: label i*2; Copy i*%1024+2 (plain body uses +1).
                    {
                        var kind_row = dvui.box(@src(), .{ .dir = .horizontal }, .{
                            .expand = .horizontal,
                            .id_extra = i,
                        });
                        defer kind_row.deinit();

                        {
                            var tl = dvui.textLayout(@src(), .{}, .{
                                .expand = .horizontal,
                                .id_extra = i * 2,
                                .color_text = kindTextColor(m.kind),
                                .font = .theme(.heading),
                                .gravity_y = 0.5,
                            });
                            tl.format("{s}", .{kindLabel(m.kind)}, .{});
                            tl.deinit();
                        }
                        if (m.text.len > 0) {
                            if (dvui.button(@src(), "Copy", .{}, .{
                                .gravity_y = 0.5,
                                .style = .content,
                                .id_extra = i *% 1024 + 2,
                                .min_size_content = .{ .w = 56, .h = TOUCH_H - 8 },
                                .corners = .round(6),
                                .color_fill = palette.teal_bg,
                                .color_text = palette.teal_accent,
                                .color_border = palette.teal_border,
                                .margin = .{ .x = 4, .y = 0, .w = 0, .h = 0 },
                            })) {
                                // Same-frame write only — do not retain ring slices.
                                dvui.clipboardTextSet(m.text);
                            }
                        }
                    }
                    {
                        if (rich.shouldPaintMarkdown(m.kind)) {
                            rich.paintMessageBody(@src(), m.kind, m.text, .{ .msg_index = i });
                        } else {
                            var tl = dvui.textLayout(@src(), .{}, .{
                                .expand = .horizontal,
                                .id_extra = i *% 1024 + 1,
                                .color_text = if (is_err) palette.ember_text else palette.teal_text,
                                .font = .theme(.body),
                            });
                            mixed_text.addTextMixed(tl, m.text, .theme(.body), .{
                                .color_text = if (is_err) palette.ember_text else palette.teal_text,
                            });
                            tl.deinit();
                        }
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

    // Conditional stick-to-bottom (plan #135 / #131 / #251).
    // Count changes cover pushMessage; content_grew covers inv_update_last_message
    // stream growth (thinking/assistant) where msg_count is unchanged.
    const max_y = transcript_scroll.scrollMax(.vertical);
    const content_grew = max_y > last_scroll_max_y + CONTENT_GREW_EPS;
    const count_changed = shown != prev_shown;

    if (n < prev_msg) {
        // Ring cleared or truncated — drop parse cache (generation bump).
        if (n == 0) rich.clearCache();
        transcript_scroll.velocity = .{ .x = 0, .y = 0 };
        scrollToBottom(&transcript_scroll);
    } else if (count_changed or content_grew) {
        const newest_is_user = blk: {
            if (n == 0) break :blk false;
            if (bridge.messageAt(n - 1)) |m| break :blk m.kind == @intFromEnum(bridge.MessageKind.user);
            break :blk false;
        };
        const user_sent = newest_is_user and shown > prev_shown;
        const hydrate = (prev_msg == 0 and n > 1) or (n >= prev_msg + 3);
        const should_follow = user_sent or hydrate or prev_msg == 0 or (near_before and user_scroll.y >= 0);
        if (should_follow) {
            scrollToBottom(&transcript_scroll);
        } else {
            clampScrollToContent(&transcript_scroll);
        }
    } else {
        clampScrollToContent(&transcript_scroll);
    }
    // Always refresh trackers (grow, shrink, no-op) so stream deltas stay accurate.
    last_shown_count = shown;
    last_msg_count = n;
    last_scroll_max_y = transcript_scroll.scrollMax(.vertical);

    // ── Composer chrome (absolute bottom band — always on-canvas) ─────────
    var typed: []const u8 = prompt_buf[0..0];
    {
        var chrome = dvui.box(@src(), .{ .dir = .vertical }, .{
            .rect = .{ .x = 0, .y = chrome_y, .w = 0, .h = chrome_h },
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_bg,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 120, .h = COMPOSER_CHROME_MIN },
            .max_size_content = .height(COMPOSER_CHROME_MIN),
            .padding = .{ .x = 0, .y = COMPOSER_PAD_Y, .w = 0, .h = 0 },
        });
        defer chrome.deinit();

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
                want_composer_focus = true;
            }
        }

        {
            var row = dvui.box(@src(), .{ .dir = .horizontal }, .{
                .expand = .horizontal,
                .min_size_content = .{ .w = 0, .h = TOUCH_H + 4 },
            });
            defer row.deinit();

            if (busy) {
                // Stop cancels inflight turn (protocol v9 pending cancel → host abort).
                if (dvui.button(@src(), "Stop", .{}, .{
                    .gravity_y = 0.5,
                    .style = .content,
                    .min_size_content = .{ .w = 72, .h = TOUCH_H },
                    .corners = .round(8),
                    .color_fill = palette.warm_bg,
                    .color_text = palette.warm_accent,
                    .color_border = palette.ember_border,
                })) {
                    bridge.queueCancelFromUi();
                }
            } else if (dvui.button(@src(), "Send", .{}, .{
                .gravity_y = 0.5,
                .style = .highlight,
                .min_size_content = .{ .w = 72, .h = TOUCH_H },
                .corners = .round(8),
            })) {
                if (typed.len > 0) {
                    submitText(typed);
                    want_composer_focus = true;
                }
            }
            if (!busy) {
                if (dvui.button(@src(), "PONG", .{}, .{
                    .gravity_y = 0.5,
                    .style = .app1,
                    .min_size_content = .{ .w = 72, .h = TOUCH_H },
                    .corners = .round(8),
                    .margin = .{ .x = 8, .y = 0, .w = 0, .h = 0 },
                })) {
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
                    tl.addText("busy… Stop to cancel", .{});
                } else {
                    tl.addText("Enter to send", .{});
                }
                tl.deinit();
            }
        }
    }
}
