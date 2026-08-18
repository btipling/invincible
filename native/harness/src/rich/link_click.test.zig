//! Host unit tests for `link_click.zig` (plan #647). Pure pointer flags → kind.
//! No dvui, no Wasm frame.

const std = @import("std");
const t = std.testing;
const link_click = @import("link_click.zig");

test "right → copy" {
    try t.expectEqual(link_click.Kind.copy, link_click.kind(.{ .right = true }));
}

test "alt → copy" {
    try t.expectEqual(link_click.Kind.copy, link_click.kind(.{ .alt = true }));
}

test "left → open" {
    try t.expectEqual(link_click.Kind.open, link_click.kind(.{}));
}

test "middle → open_new" {
    try t.expectEqual(link_click.Kind.open_new, link_click.kind(.{ .middle = true }));
}

test "ctrl/cmd → open_new" {
    try t.expectEqual(link_click.Kind.open_new, link_click.kind(.{ .ctrl_cmd = true }));
}

test "alt+ctrl → copy (copy wins)" {
    try t.expectEqual(link_click.Kind.copy, link_click.kind(.{ .alt = true, .ctrl_cmd = true }));
}

test "right+middle → copy (copy wins)" {
    try t.expectEqual(link_click.Kind.copy, link_click.kind(.{ .right = true, .middle = true }));
}
