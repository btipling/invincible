//! Cwd status-slot visibility rule (plan #579). Extracted so the "."-hidden
//! predicate is testable without pulling in dvui (adversarial review #584 Minor L6).
const std = @import("std");

/// True when a non-empty cwd status-slot value is visible in the status bar.
/// "." is the workspace-root default and is hidden (trivial chip — plan #579).
pub fn isVisible(raw: []const u8) bool {
    return !std.mem.eql(u8, raw, ".");
}
