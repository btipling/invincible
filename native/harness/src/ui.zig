//! Harness UI (dvui). Grows into agent loop / palette chrome in later Phase 3 issues.
const dvui = @import("dvui");

var click_count: u32 = 0;

pub fn onInit() void {
    click_count = 0;
}

pub fn onDeinit() void {}

pub fn frame() !void {
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
        tl.addText("Invincible harness", .{});
        tl.deinit();
    }

    {
        var tl = dvui.textLayout(@src(), .{}, .{ .expand = .horizontal });
        tl.addText(
            \\Zig + dvui Wasm agent harness (Phase 3).
            \\Prompt → Gateway wiring lands in later issues.
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
