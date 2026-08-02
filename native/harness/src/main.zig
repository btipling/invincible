//! Invincible harness Wasm entry (dvui web backend).
//!
//! Export surface is fixed by dvui's web.js host:
//!   dvui_init, dvui_deinit, dvui_update, add_event, arena_u8, gpa_u8, gpa_free, new_font
//! Invincible bridge exports (`inv_*`) live in `bridge.zig` (whitelist in build.zig).
const std = @import("std");
const dvui = @import("dvui");
const WebBackend = @import("web-backend");
const ui = @import("ui.zig");
// Keep bridge in the module graph (exports + PROTOCOL_VERSION).
const bridge = @import("bridge.zig");

comptime {
    std.debug.assert(@hasDecl(WebBackend, "WebBackend"));
    std.debug.assert(bridge.PROTOCOL_VERSION >= 1);
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

export fn dvui_init(platform_ptr: [*]const u8, platform_len: usize) i32 {
    const platform = platform_ptr[0..platform_len];
    dvui.log.debug("invincible harness platform: {s}", .{platform});
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
    ui.onInit();
    return 0;
}

export fn dvui_deinit() void {
    ui.onDeinit();
    WebBackend.win.deinit();
    WebBackend.back.deinit();
}

/// Returns ms to wait for next frame (-1 = quit). Called by web.js animation loop.
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
    try ui.frame();
    const end_micros = try WebBackend.win.end(.{});
    WebBackend.back.setCursor(WebBackend.win.cursorRequested());
    WebBackend.back.textInputRect(WebBackend.win.textInputRequested());
    const wait_event_micros = WebBackend.win.waitTime(end_micros);
    return @intCast(@divTrunc(wait_event_micros, 1000));
}
