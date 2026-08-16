//! Host unit tests for `cwd_slot.zig` (no dvui frame — runs in
//! `build.zig` `test-rich` on the self-hosted runner).

const std = @import("std");
const t = std.testing;
const cwd_slot = @import("cwd_slot.zig");

test "cwdSlotIsVisible: dot is hidden" {
    try t.expect(!cwd_slot.isVisible("."));
}

test "cwdSlotIsVisible: root slash is visible" {
    try t.expect(cwd_slot.isVisible("/"));
}

test "cwdSlotIsVisible: named directory is visible" {
    try t.expect(cwd_slot.isVisible("invincible"));
}

test "cwdSlotIsVisible: empty string is visible (caller hides empty)" {
    try t.expect(cwd_slot.isVisible(""));
}

test "cwdSlotIsVisible: deeper path is visible" {
    try t.expect(cwd_slot.isVisible("invincible/docs"));
}
