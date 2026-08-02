//! Harness UI (dvui). Transcript + prompt entry; host runs /api/chat (Phase 3.7).
const dvui = @import("dvui");
const bridge = @import("bridge.zig");

/// Fixed prompt buffer for textEntry.
var prompt_buf: [bridge.SUBMIT_CAP]u8 = [_]u8{0} ** bridge.SUBMIT_CAP;

const SMOKE_PROMPT = "Reply with exactly: PONG";

pub fn onInit() void {
    bridge.reset();
    @memset(&prompt_buf, 0);
}

pub fn onDeinit() void {}

fn kindLabel(kind: u8) []const u8 {
    return switch (kind) {
        1 => "user",
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
        .margin = .all(12),
        .padding = .all(12),
    });
    defer box.deinit();

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal, .font = .theme(.title) });
        tl.addText("Invincible harness", .{});
        tl.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.format(
            "protocol v{d}  ·  lifecycle: {s}\nHost POSTs /api/chat (Gateway key stays on server).\n",
            .{ bridge.PROTOCOL_VERSION, lifecycleLabel(life) },
            .{},
        );
        tl.deinit();
    }

    // Prompt field — slice remains valid after deinit (points into prompt_buf).
    var typed: []const u8 = prompt_buf[0..0];
    {
        var te = dvui.textEntry(@src(), .{
            .text = .{ .buffer = prompt_buf[0..] },
            .placeholder = "Type a prompt…",
            .multiline = false,
        }, .{
            .expand = .horizontal,
            .min_size_content = .{ .w = 200, .h = 24 },
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

        if (dvui.button(@src(), "Send", .{}, .{ .gravity_y = 0.5 })) {
            if (!busy and typed.len > 0) {
                submitText(typed);
            }
        }

        if (dvui.button(@src(), "Smoke: PONG", .{}, .{ .gravity_y = 0.5 })) {
            if (!busy) {
                submitText(SMOKE_PROMPT);
            }
        }
    }

    if (busy) {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.addText("Waiting for model…\n", .{});
        tl.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal, .font = .theme(.title) });
        tl.addText("Transcript", .{});
        tl.deinit();
    }

    const n = bridge.messageCount();
    if (n == 0) {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.addText("(empty — send a prompt or run Smoke: PONG)", .{});
        tl.deinit();
    } else {
        var i: usize = 0;
        while (i < n) : (i += 1) {
            if (bridge.messageAt(i)) |m| {
                var tl = dvui.textLayout(@src(), .{}, .{
                    .expand = .horizontal,
                    .id_extra = i,
                });
                tl.format("[{s}] {s}\n", .{ kindLabel(m.kind), m.text }, .{});
                tl.deinit();
            }
        }
    }
}
