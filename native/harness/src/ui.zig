//! Harness UI (dvui). Asteronica-themed companion to the DOM agent panel.
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

/// Role → Asteronica text color (matches DOM bubble labels).
fn kindTextColor(kind: u8) dvui.Color {
    return switch (kind) {
        1 => palette.teal_accent, // user
        2 => palette.warm_accent, // assistant
        3 => palette.teal_muted, // system
        4 => palette.ember_accent, // error
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

    var box = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .both,
        .background = true,
        .style = .window,
        .margin = .all(10),
        .padding = .all(10),
        .color_fill = palette.teal_bg,
        .color_text = palette.teal_text,
        .color_border = palette.teal_border,
    });
    defer box.deinit();

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .font = .theme(.title),
            .color_text = palette.teal_text,
        });
        tl.addText("Wasm surface", .{});
        tl.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .color_text = palette.teal_muted,
        });
        tl.format(
            "lifecycle: {s}  ·  Asteronica theme\n",
            .{lifecycleLabel(life)},
            .{},
        );
        tl.deinit();
    }

    var typed: []const u8 = prompt_buf[0..0];
    {
        var te = dvui.textEntry(@src(), .{
            .text = .{ .buffer = prompt_buf[0..] },
            .placeholder = "Optional Wasm prompt…",
            .multiline = false,
        }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 160, .h = 22 },
            .color_fill = palette.teal_surface,
            .color_text = palette.teal_text,
            .color_border = palette.teal_border,
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

        // Send — TEAL primary (highlight)
        if (dvui.button(@src(), "Send", .{}, .{
            .gravity_y = 0.5,
            .style = .highlight,
        })) {
            if (!busy and typed.len > 0) submitText(typed);
        }

        // PONG smoke — WARM accent (app1)
        if (dvui.button(@src(), "PONG", .{}, .{
            .gravity_y = 0.5,
            .style = .app1,
        })) {
            if (!busy) submitText(SMOKE_PROMPT);
        }
    }

    if (busy) {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .style = .app3,
            .color_text = palette.warm_accent,
        });
        tl.addText("Waiting for model…\n", .{});
        tl.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .color_text = palette.teal_muted,
        });
        tl.addText("Mirror transcript\n", .{});
        tl.deinit();
    }

    const n = bridge.messageCount();
    if (n == 0) {
        var tl = dvui.textLayout(@src(), .{}, .{
            .expand = .horizontal,
            .color_text = palette.teal_muted,
        });
        tl.addText("(empty)", .{});
        tl.deinit();
    } else {
        const start: usize = if (n > 6) n - 6 else 0;
        var i: usize = start;
        while (i < n) : (i += 1) {
            if (bridge.messageAt(i)) |m| {
                const is_err = m.kind == 4;
                var tl = dvui.textLayout(@src(), .{}, .{
                    .expand = .horizontal,
                    .id_extra = i,
                    .color_text = kindTextColor(m.kind),
                    .color_fill = if (is_err) palette.ember_surface else null,
                    .color_border = if (is_err) palette.ember_border else null,
                    .style = if (is_err) .err else .content,
                });
                tl.format("[{s}] {s}\n", .{ kindLabel(m.kind), m.text }, .{});
                tl.deinit();
            }
        }
    }
}
