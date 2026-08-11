//! Phase-1 red-fixture / investigation suite for #387 (harness rich MD glue).
//!
//! NOT linked into the default `test-rich` step — run explicitly with
//! `zig build test-rich-red`. These pin the #387 assistant-transcript
//! whitespace / block-boundary invariants so phase 2 (parent #390) has a
//! concrete target and so no Wasm fix can regress the well-formed input path.
//!
//! IMPORTANT (honest scoping): Wasm `parse.zig` is *faithful* — a glued source
//! blob yields a glued flat AST, and a well-formed source already yields
//! correct block separation. The #387 glue is now **pre-convicted upstream**
//! (the stored source is itself glued; see parent #390's operator probe), so
//! the *actual failing* repro cannot be produced at the Wasm parse layer — the
//! layer is the crown witness, not the culprit. The fixtures below therefore
//! pin the contract (block break + run-space preservation) as regression
//! protection; the genuinely failing red repro for phase 1 lives in the host
//! red suite (`lib/harnessChat.test.red.ts`, `npm run test:red`).
//!
//! Phase-1 rule: "no production / Wasm artifact behavior change." These tests
//! must stay green; if any turns red in phase 2, that IS the failing target.
const std = @import("std");
const parse = @import("parse.zig");

fn joinBlockText(a: std.mem.Allocator, blk: parse.Block) ![]u8 {
    var joined: std.ArrayList(u8) = .empty;
    errdefer joined.deinit(a);
    for (blk.inlines) |inl| {
        try joined.appendSlice(a, inl.text);
    }
    return joined.toOwnedSlice(a);
}

test "#387 heading -> paragraph block break is exactly two blocks (well-formed source)" {
    const src =
        \\## What I did
        \\
        \\The adversarial review verdict was **CONCERNS**.
    ;
    var doc = try parse.parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 2), doc.blocks.len);
    try std.testing.expectEqual(parse.BlockKind.heading, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(u8, 2), doc.blocks[0].level);
    try std.testing.expectEqual(parse.BlockKind.paragraph, doc.blocks[1].kind);
}

test "#387 word + space + number keeps the literal space in the stored inline run" {
    const src = "The status is with 401 and got **503** error.";
    var doc = try parse.parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 1), doc.blocks.len);
    const joined = try joinBlockText(std.testing.allocator, doc.blocks[0]);
    defer std.testing.allocator.free(joined);
    // The literal spaces between word/number and word/`**…**` survive the parse:
    // the source's spaces belong to adjacent text runs and must never be
    // swallowed into a glued `with401` / `got**503**` byte string.
    try std.testing.expect(std.mem.indexOf(u8, joined, "with 401") != null);
    try std.testing.expect(std.mem.indexOf(u8, joined, "got 503") != null);
    var saw_strong = false;
    for (doc.blocks[0].inlines) |inl| {
        if (inl.flags.strong) {
            saw_strong = true;
            try std.testing.expectEqualStrings("503", inl.text);
        }
    }
    try std.testing.expect(saw_strong);
}

test "#387 heading immediately followed by strong keeps space between heading and bold (well-formed source)" {
    const src =
        \\## What I did
        \\
        \\**Feedback disposition:** The review passed.
    ;
    var doc = try parse.parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 2), doc.blocks.len);
    try std.testing.expectEqual(parse.BlockKind.heading, doc.blocks[0].kind);
    try std.testing.expectEqual(parse.BlockKind.paragraph, doc.blocks[1].kind);
    var saw_strong = false;
    for (doc.blocks[1].inlines) |inl| {
        if (inl.flags.strong) saw_strong = true;
    }
    try std.testing.expect(saw_strong);
}
