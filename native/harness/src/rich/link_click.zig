//! Pure copy-vs-open policy for transcript links (plan #647).
//! No dvui import — host-testable under `zig build test-rich`.

pub const Kind = enum { copy, open, open_new };

pub const Pointer = struct {
    right: bool = false,
    middle: bool = false,
    alt: bool = false,
    ctrl_cmd: bool = false,
};

/// Right-click or Alt → copy URL. Middle or Ctrl/Cmd → open in a new window.
/// Alt+Ctrl is copy (copy is checked first). Plain left → open.
pub fn kind(p: Pointer) Kind {
    if (p.right or p.alt) return .copy;
    if (p.middle or p.ctrl_cmd) return .open_new;
    return .open;
}
