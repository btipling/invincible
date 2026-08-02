//! Harness UI (dvui). Bridge-driven transcript + lifecycle chrome (Phase 3.6).
const dvui = @import("dvui");
const bridge = @import("bridge.zig");

pub fn onInit() void {
    bridge.reset();
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

pub fn frame() !void {
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
            "protocol v{d}  ·  lifecycle: {s}\nJS ↔ Wasm bridge (3.6). Gateway wiring is 3.7.\n",
            .{ bridge.PROTOCOL_VERSION, lifecycleLabel(bridge.getLifecycle()) },
            .{},
        );
        tl.deinit();
    }

    if (dvui.button(@src(), "Queue host submit (stub)", .{}, .{})) {
        // Wasm → JS path: host polls inv_has_pending_submit (no network).
        bridge.queueSubmitFromUi("bridge-stub");
    }

    const echo = bridge.lastEcho();
    if (echo.len > 0) {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.format("Last echo: {s}\n", .{echo}, .{});
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
        tl.addText("(empty — host pushes messages via inv_push_message)", .{});
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
