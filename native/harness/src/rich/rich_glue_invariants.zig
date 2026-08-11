//! Phase-1/3 rich-glue invariant suite for #387 (harness rich MD) + related
//! bug drift-guards (#341 still open / #343 fixed).
//!
//! NOT linked into the default `test-rich` step — run explicitly with
//! `zig build test-rich-invariants`. These pin the #387 assistant-transcript
//! whitespace / block-boundary invariants so phase 2 (parent #390) has a
//! concrete target and so no Wasm fix can regress the well-formed input path,
//! plus the phase-3 current-behavior drift-guards for #341 (still OPEN) and
//! #343 (now FIXED; its guard pins the corrected angle-bracket-autolink href),
//! alongside #336's fixed emph-split guard pinning the corrected literal
//! underscore behavior.
//! Though parked under an investigation suite, these tests are GREEN (they pin
//! the parse contract) — not red known-failures.
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

// ---------------------------------------------------------------------------
// Phase-3 (parent #390) related-bug drift-guards. #341 is STILL OPEN and is OUT
// of scope to fix here; #336 was fixed in its own PR (its drift-guard below now
// pins the corrected literal-underscore behavior); #343 was fixed in its own PR
// too (its guard below now pins the corrected angle-bracket-autolink href).
// These tests are GREEN snapshot guards that PIN THE parse behavior so the
// #387 whitespace/boundary change cannot silently shift them. They are
// drift-locks, NOT correctness fixes: when a bug is independently fixed, update
// that guard in the bug's own PR (and the guard may move from this suite into
// the normal parse tests). They live here (not in `test-rich`) so an open-bug
// expectation never bakes into the default release gate.
// ---------------------------------------------------------------------------

test "#336 fixed: word-internal underscore identifiers stay one literal run" {
    // #336: multi-word `snake_case` identifiers can render an underscore word
    // as italics. Fixed in the bug's own PR via the pre-pass GFM no-intra-word
    // `_` rule (word-internal `_` lowered to a literal). `use snake_case_here ok`
    // is now ONE literal text run with no emph split.
    var doc = try parse.parse(std.testing.allocator, "use snake_case_here ok");
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 1), doc.blocks.len);
    try std.testing.expectEqual(parse.BlockKind.paragraph, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(usize, 1), doc.blocks[0].inlines.len);
    try std.testing.expectEqualStrings("use snake_case_here ok", doc.blocks[0].inlines[0].text);
    try std.testing.expect(!doc.blocks[0].inlines[0].flags.emph);
}

test "#343 fixed: angle-bracket autolink href stays clean (no trailing '>' in the URL run)" {
    // #343: `<https://…>` must autolink to the clean inner URL — the closing `>`
    // must NOT be absorbed into the href. Fixed in #343's own PR via a CM
    // angle-bracket scan rule in `link_url.zig` (`findBareHttpUrl`: stop the
    // body at the first `>` when the scheme is immediately preceded by `<`).
    // This guard now pins the corrected output: the link run is
    // `https://example.com/a_b` and the `<>` wrappers are separate plain runs.
    var doc = try parse.parse(std.testing.allocator, "see <https://example.com/a_b> now");
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 1), doc.blocks.len);
    try std.testing.expectEqual(parse.BlockKind.paragraph, doc.blocks[0].kind);
    try std.testing.expectEqual(@as(usize, 3), doc.blocks[0].inlines.len);
    try std.testing.expectEqual(parse.InlineKind.link, doc.blocks[0].inlines[1].kind);
    try std.testing.expectEqualStrings("see <", doc.blocks[0].inlines[0].text);
    try std.testing.expectEqualStrings("https://example.com/a_b", doc.blocks[0].inlines[1].text);
    try std.testing.expectEqualStrings("> now", doc.blocks[0].inlines[2].text);
    // Belt-and-suspenders (PR #401 review L6 Nit): assert the stored href too,
    // not just the label run. `autolinkTextInlines` currently uses one `url_dupe`
    // for both `text` and `href`, so this is redundant today — but it locks the
    // contract against a future divergence between the two.
    try std.testing.expect(doc.blocks[0].inlines[1].href != null);
    try std.testing.expectEqualStrings("https://example.com/a_b", doc.blocks[0].inlines[1].href.?);
}

test "#341 drift-guard: loose ordered list currently renumbers each item to 'o,1' (OPEN bug, not fixed here)" {
    // #341: ordered markers reset to `1.` on the loose-list / blank-line path.
    // On `main`, `1. one\\n\\n2. two\\n\\n1. reset` yields THREE `o,1` list_item
    // blocks (the `2.` resets to `1.`). Pin the CURRENT output as a drift
    // guard; the preserved-counter fix belongs to #341.
    const src = "1. one\n\n2. two\n\n1. reset";
    var doc = try parse.parse(std.testing.allocator, src);
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 3), doc.blocks.len);
    for (doc.blocks) |blk| {
        try std.testing.expectEqual(parse.BlockKind.list_item, blk.kind);
        try std.testing.expectEqualStrings("o,1", blk.meta orelse return error.NoOrderedMeta);
    }
}
