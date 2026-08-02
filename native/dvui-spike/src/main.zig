//! Invincible Phase 3.1 spike: minimal dvui → Wasm (web backend).
//! Proves Zig 0.16.0 + dvui web can paint a canvas-backed UI.
const std = @import("std");
const dvui = @import("dvui");
const WebBackend = @import("web-backend");

comptime {
    std.debug.assert(@hasDecl(WebBackend, "WebBackend"));
}

var wasm_log_console_buffer: [512]u8 = undefined;
pub var js_console = WebBackend.Console.init(&wasm_log_console_buffer);

pub fn logFn(
    comptime message_level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    if (scope != .default) {
        js_console.writer.print("({s}): ", .{@tagName(scope)}) catch unreachable;
    }
    js_console.writer.print(format, args) catch unreachable;
    js_console.flushAtLevel(message_level);
}

pub const std_options: std.Options = .{
    .logFn = logFn,
};

var click_count: u32 = 0;

export fn dvui_init(platform_ptr: [*]const u8, platform_len: usize) i32 {
    const platform = platform_ptr[0..platform_len];
    dvui.log.debug("invincible spike platform: {s}", .{platform});
    const mac = std.mem.indexOf(u8, platform, "Mac") != null;

    WebBackend.back = WebBackend.init() catch {
        return 1;
    };
    WebBackend.win = dvui.Window.init(@src(), WebBackend.gpa, WebBackend.back.backend(), .{
        .keybinds = if (mac) .mac else .windows,
    }) catch {
        return 2;
    };
    WebBackend.win_ok = true;
    return 0;
}

export fn dvui_deinit() void {
    WebBackend.win.deinit();
    WebBackend.back.deinit();
}

export fn dvui_update() i32 {
    return update() catch |err| {
        std.log.err("{any}", .{err});
        const msg = std.fmt.allocPrint(WebBackend.gpa, "{any}", .{err}) catch "allocPrint OOM";
        WebBackend.wasm.wasm_panic(msg.ptr, msg.len);
        return -1;
    };
}

fn update() !i32 {
    const nstime = WebBackend.win.beginWait(WebBackend.back.hasEvent());
    try WebBackend.win.begin(nstime);
    try frame();
    const end_micros = try WebBackend.win.end(.{});
    WebBackend.back.setCursor(WebBackend.win.cursorRequested());
    WebBackend.back.textInputRect(WebBackend.win.textInputRequested());
    const wait_event_micros = WebBackend.win.waitTime(end_micros);
    return @intCast(@divTrunc(wait_event_micros, 1000));
}

fn frame() !void {
    var box = dvui.box(@src(), .{ .dir = .vertical }, .{
        .expand = .both,
        .background = true,
        .style = .window,
        .margin = .all(16),
        .padding = .all(16),
    });
    defer box.deinit();

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal, .font = .theme(.title) });
        tl.addText("Invincible · dvui Wasm spike", .{});
        tl.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.addText(
            \\Phase 3.1 harness proof on invincible-do-1.
            \\Backend: dvui web (WebGL canvas). Compiler: Zig 0.16.0.
            \\
        , .{});
        tl.deinit();
    }

    if (dvui.button(@src(), "Click me", .{}, .{})) {
        click_count += 1;
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.format("Clicks: {d}", .{click_count}, .{});
        tl.deinit();
    }
}
