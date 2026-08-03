//! Harness product UI (dvui) — Phase 4 Wasm-primary agent workspace.
//! DOM host only loads this surface + owns /api/chat; chat UX lives here.
const dvui = @import("dvui");
const bridge = @import("bridge.zig");
const palette = @import("palette.zig");

var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

const SMOKE_PROMPT = "Reply with exactly: PONG";

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
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

    var root = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .both,
        .background = true,
        .style = .window,
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_text,
        .color_border = palette.teal_border,
        .padding = .all(12),
    });
    defer root.deinit();

    // Header
    {
        var head = dvui.box(@src(), .{ .dir = .horizontal }, .{
            .expand = .horizontal,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .padding = .all(8),
            .margin = .{ .x = 0, .y = 0, .w = 0, .h = 8 },
        });
        defer head.deinit();

        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .font = .theme(.heading),
                .color_text = palette.teal_text,
            });
            tl.addText("Agent harness", .{});
            tl.deinit();
        }
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .color_text = if (busy) palette.warm_accent else palette.teal_muted,
            });
            tl.format("{s}", .{lifecycleLabel(life)}, .{});
            tl.deinit();
        }
    }

    // Transcript (scroll-friendly expand)
    {
        var scroll = dvui.scrollArea(@src(), .{}, .{
            .expand = .both,
            .background = true,
            .color_fill = palette.teal_surface,
            .color_border = palette.teal_border,
            .min_size_content = .{ .w = 200, .h = 160 },
            .padding = .all(10),
            .margin = .{ .x = 0, .y = 0, .w = 0, .h = 8 },
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
            tl.addText("Start a conversation\n\nType below and press Enter or Send.\nSmoke: PONG checks the host Gateway path.\n", .{});
            tl.deinit();
        } else {
            var i: usize = 0;
            while (i < n) : (i += 1) {
                if (bridge.messageAt(i)) |m| {
                    const is_err = m.kind == 4;
                    var tl = dvui.textLayout(@src(), .{}, .{
                        .expand = .horizontal,
                        .id_extra = i,
                        .color_text = kindTextColor(m.kind),
                        .color_fill = if (is_err) palette.ember_surface else null,
                        .style = if (is_err) .err else .content,
                        .margin = .{ .x = 0, .y = 0, .w = 0, .h = 6 },
                    });
                    tl.format("[{s}]\n{s}\n", .{ kindLabel(m.kind), m.text }, .{});
                    tl.deinit();
                }
            }
        }

        if (busy) {
            var tl = dvui.textLayout(@src(), .{}, .{
                .expand = .horizontal,
                .color_text = palette.warm_accent,
            });
            tl.addText("Waiting for model…\n", .{});
            tl.deinit();
        }
    }

    // Composer
    var typed: []const u8 = prompt_buf[0..0];
    {
        var te = dvui.textEntry(@src(), .{
            .text = .{ .buffer = prompt_buf[0..] },
            .placeholder = "Message the model…",
            .multiline = true,
        }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 200, .h = 56 },
            .color_fill = palette.teal_bg,
            .color_text = palette.teal_text,
            .color_border = palette.teal_border,
            .margin = .{ .x = 0, .y = 0, .w = 0, .h = 8 },
        });
        typed = te.getText();
        const enter = te.enter_pressed and !busy;
        te.deinit();
        if (enter and typed.len > 0) {
            submitText(typed);
            typed = prompt_buf[0..0];
        }
    }

    {
        var row = dvui.box(@src(), .{ .dir = .horizontal }, .{ .expand = .horizontal });
        defer row.deinit();

        if (dvui.button(@src(), "Send", .{}, .{
            .gravity_y = 0.5,
            .style = .highlight,
        })) {
            if (!busy and typed.len > 0) submitText(typed);
        }
        if (dvui.button(@src(), "PONG", .{}, .{
            .gravity_y = 0.5,
            .style = .app1,
        })) {
            if (!busy) submitText(SMOKE_PROMPT);
        }
        {
            var tl = dvui.textLayout(@src(), .{}, .{
                .gravity_y = 0.5,
                .color_text = palette.teal_muted,
            });
            tl.addText("  Enter to send", .{});
            tl.deinit();
        }
    }
}
