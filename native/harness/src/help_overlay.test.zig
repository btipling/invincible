//! Host unit tests for ui/help_overlay.zig (plan #761 Nit L6).
//!
//! `rowChord` is a hardcoded parallel `switch (row.action)` — the chord glyphs
//! are NOT derived from the keymap table. Without a test, a revert of
//! help_overlay.zig to the pre-#761 "Leader Space" strings would ship while
//! keymap.zig tests stay green. These tests pin the leader-family glyphs so a
//! revert fails CI.
//!
//! No dvui frame needed: the tests call `rowChord` only. The module imports
//! dvui (via mixed_text), so the test wires dvui_testing and nothing else
//! (the module compiles, `paint` is not invoked).
const std = @import("std");
const help = @import("ui/help_overlay.zig");
const keymap = @import("keymap.zig");

test "help_overlay: leader chord glyphs are Ctrl+I family (plan #761 Nit L6)" {
    const want = [_]struct { action: keymap.Action, chord: []const u8 }{
        .{ .action = .leader, .chord = "Ctrl+I" },
        .{ .action = .help_toggle_leader, .chord = "Leader I, then ?" },
        .{ .action = .thinking_default_toggle, .chord = "Leader I, then t" },
    };
    for (want) |w| {
        var matched = false;
        for (keymap.KEY_TABLE) |row| {
            if (row.action == w.action) {
                matched = true;
                try std.testing.expectEqualStrings(w.chord, help.rowChord(row));
            }
        }
        try std.testing.expect(matched);
    }
}

test "help_overlay: no stale Space / Ctrl+Shift+Space chord survives (plan #761 Nit L6)" {
    // The old leader prefix register (Ctrl+Shift+Space, plan #741) is gone.
    // Any residual "Space" in a rendered chord is stale copy from the pre-#761
    // table; a revert to `Leader Space, then ?` / `Ctrl+Shift+Space` fails here.
    var saw_leader = false;
    for (keymap.KEY_TABLE) |row| {
        if (row.action == .leader) saw_leader = true;
        const chord = help.rowChord(row);
        try std.testing.expect(std.mem.indexOf(u8, chord, "Space") == null);
    }
    try std.testing.expect(saw_leader);
}

test "help_overlay: row.help copy carries no stale Space chord (plan #761 Nit L6)" {
    for (keymap.KEY_TABLE) |row| {
        try std.testing.expect(std.mem.indexOf(u8, row.help, "Space") == null);
    }
}
