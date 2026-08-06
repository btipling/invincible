//! Lightweight fence token highlighter (no Tree-sitter, no dvui).
//! Allowlisted langs only; pure Zig host-testable.
const std = @import("std");

pub const TokenKind = enum {
    default,
    keyword,
    string,
    comment,
    number,
};

pub const LangFamily = enum {
    zig,
    c_cpp,
    ecma,
    python,
    json,
    shell,
};

pub const Token = struct {
    start: usize,
    len: usize,
    kind: TokenKind,
};

/// True when fence meta is in the v1 allowlist (case-insensitive, trimmed).
/// Never true for `diff` / `patch` (diff paint owns those).
pub fn isHighlightLang(meta: ?[]const u8) bool {
    return resolveFamily(meta) != null;
}

pub fn resolveFamily(meta: ?[]const u8) ?LangFamily {
    const raw = meta orelse return null;
    const t = std.mem.trim(u8, raw, " \t\r\n");
    if (t.len == 0) return null;
    // Diff path owns these — never highlight.
    if (eqlIgnoreCase(t, "diff") or eqlIgnoreCase(t, "patch")) return null;

    if (eqlIgnoreCase(t, "zig")) return .zig;

    if (eqlIgnoreCase(t, "c") or eqlIgnoreCase(t, "h") or eqlIgnoreCase(t, "cpp") or
        eqlIgnoreCase(t, "cc") or eqlIgnoreCase(t, "cxx") or eqlIgnoreCase(t, "c++") or
        eqlIgnoreCase(t, "hpp") or eqlIgnoreCase(t, "hh") or eqlIgnoreCase(t, "hxx"))
        return .c_cpp;

    if (eqlIgnoreCase(t, "ts") or eqlIgnoreCase(t, "typescript") or eqlIgnoreCase(t, "js") or
        eqlIgnoreCase(t, "javascript") or eqlIgnoreCase(t, "tsx") or eqlIgnoreCase(t, "jsx"))
        return .ecma;

    if (eqlIgnoreCase(t, "python") or eqlIgnoreCase(t, "py")) return .python;
    if (eqlIgnoreCase(t, "json")) return .json;
    if (eqlIgnoreCase(t, "bash") or eqlIgnoreCase(t, "sh") or eqlIgnoreCase(t, "shell")) return .shell;

    return null;
}

/// Lex `src` into `out`. Returns number of tokens written (may equal out.len if capped).
/// Covers the full body with contiguous tokens. Never panics.
pub fn lexInto(src: []const u8, family: LangFamily, out: []Token) usize {
    if (out.len == 0) return 0;
    var n: usize = 0;
    var i: usize = 0;
    while (i < src.len) {
        if (n >= out.len) break;

        // Whitespace → default (keeps spans simple)
        if (isSpace(src[i])) {
            const start = i;
            i += 1;
            while (i < src.len and isSpace(src[i])) : (i += 1) {}
            n = push(out, n, start, i - start, .default);
            continue;
        }

        // Comments
        if (tryLineComment(src, &i, family, out, &n)) continue;
        if (tryBlockComment(src, &i, family, out, &n)) continue;

        // Strings
        if (tryString(src, &i, family, out, &n)) continue;

        // Numbers
        if (tryNumber(src, &i, out, &n)) continue;

        // Identifier / keyword
        if (isIdentStart(src[i])) {
            const start = i;
            i += 1;
            while (i < src.len and isIdentCont(src[i])) : (i += 1) {}
            const word = src[start..i];
            const kind: TokenKind = if (isKeyword(word, family)) .keyword else .default;
            n = push(out, n, start, i - start, kind);
            continue;
        }

        // Punctuation / other → default; keep UTF-8 sequences whole so paint
        // never receives a split multi-byte slice (mono path paints whole lines).
        const take = utf8SeqLen(src, i);
        n = push(out, n, i, take, .default);
        i += take;
    }
    return n;
}

fn push(out: []Token, n: usize, start: usize, len: usize, kind: TokenKind) usize {
    if (n >= out.len or len == 0) return n;
    out[n] = .{ .start = start, .len = len, .kind = kind };
    return n + 1;
}

fn tryLineComment(src: []const u8, i: *usize, family: LangFamily, out: []Token, n: *usize) bool {
    const idx = i.*;
    switch (family) {
        .python, .shell => {
            if (src[idx] != '#') return false;
        },
        .json => return false,
        .zig, .c_cpp, .ecma => {
            if (idx + 1 >= src.len or src[idx] != '/' or src[idx + 1] != '/') return false;
        },
    }
    const start = idx;
    var j = idx;
    while (j < src.len and src[j] != '\n') : (j += 1) {}
    i.* = j;
    n.* = push(out, n.*, start, j - start, .comment);
    return true;
}

fn tryBlockComment(src: []const u8, i: *usize, family: LangFamily, out: []Token, n: *usize) bool {
    switch (family) {
        .zig, .c_cpp, .ecma => {},
        else => return false,
    }
    const idx = i.*;
    if (idx + 1 >= src.len or src[idx] != '/' or src[idx + 1] != '*') return false;
    const start = idx;
    var j = idx + 2;
    while (j + 1 < src.len) : (j += 1) {
        if (src[j] == '*' and src[j + 1] == '/') {
            j += 2;
            break;
        }
    } else {
        j = src.len; // unclosed → rest is comment
    }
    i.* = j;
    n.* = push(out, n.*, start, j - start, .comment);
    return true;
}

fn tryString(src: []const u8, i: *usize, family: LangFamily, out: []Token, n: *usize) bool {
    const idx = i.*;
    const c = src[idx];
    // v1: double and single quotes only (no template literals / zig \\ multiline)
    if (c != '"' and c != '\'') return false;
    // JSON: only double quotes
    if (family == .json and c != '"') return false;
    // Shell single-quoted: no escapes
    const start = idx;
    var j = idx + 1;
    if (family == .shell and c == '\'') {
        while (j < src.len and src[j] != '\'') : (j += 1) {}
        if (j < src.len) j += 1;
        i.* = j;
        n.* = push(out, n.*, start, j - start, .string);
        return true;
    }
    // Escapes for " and '
    while (j < src.len) {
        if (src[j] == '\\' and j + 1 < src.len) {
            j += 2;
            continue;
        }
        if (src[j] == c) {
            j += 1;
            break;
        }
        if (src[j] == '\n') break; // unclosed at newline — still mark as string so far
        j += 1;
    }
    i.* = j;
    n.* = push(out, n.*, start, j - start, .string);
    return true;
}

fn tryNumber(src: []const u8, i: *usize, out: []Token, n: *usize) bool {
    const idx = i.*;
    // hex
    if (idx + 2 < src.len and src[idx] == '0' and (src[idx + 1] == 'x' or src[idx + 1] == 'X') and isHex(src[idx + 2])) {
        var j = idx + 3;
        while (j < src.len and isHex(src[j])) : (j += 1) {}
        i.* = j;
        n.* = push(out, n.*, idx, j - idx, .number);
        return true;
    }
    if (!isDigit(src[idx])) return false;
    // don't treat 1foo as number if we want — but ident would not start with digit
    var j = idx + 1;
    while (j < src.len and isDigit(src[j])) : (j += 1) {}
    // simple fraction
    if (j < src.len and src[j] == '.' and j + 1 < src.len and isDigit(src[j + 1])) {
        j += 1;
        while (j < src.len and isDigit(src[j])) : (j += 1) {}
    }
    i.* = j;
    n.* = push(out, n.*, idx, j - idx, .number);
    return true;
}

fn isKeyword(word: []const u8, family: LangFamily) bool {
    const table = keywordsFor(family);
    for (table) |kw| {
        if (std.mem.eql(u8, word, kw)) return true;
    }
    return false;
}

fn keywordsFor(family: LangFamily) []const []const u8 {
    return switch (family) {
        .zig => &zig_kw,
        .c_cpp => &c_kw,
        .ecma => &ecma_kw,
        .python => &py_kw,
        .json => &json_kw,
        .shell => &shell_kw,
    };
}

const zig_kw = [_][]const u8{
    "const", "var", "fn", "pub", "try", "catch", "if", "else", "while", "for",
    "return", "struct", "enum", "union", "switch", "defer", "errdefer", "async",
    "await", "export", "extern", "inline", "comptime", "test", "and", "or",
    "null", "undefined", "true", "false", "break", "continue", "opaque", "type",
    "anytype", "void", "bool", "usize", "isize",
};

const c_kw = [_][]const u8{
    "auto", "break", "case", "char", "const", "continue", "default", "do",
    "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
    "int", "long", "register", "restrict", "return", "short", "signed", "sizeof",
    "static", "struct", "switch", "typedef", "union", "unsigned", "void",
    "volatile", "while", "_Bool", "_Complex", "class", "namespace", "template",
    "typename", "public", "private", "protected", "virtual", "override", "new",
    "delete", "this", "true", "false", "nullptr", "using", "constexpr",
};

const ecma_kw = [_][]const u8{
    "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "export", "extends", "false", "finally", "for",
    "function", "if", "import", "in", "instanceof", "let", "new", "null",
    "return", "super", "switch", "this", "throw", "true", "try", "typeof",
    "var", "void", "while", "with", "yield", "async", "await", "of", "from",
    "as", "type", "interface", "enum", "implements", "private", "public",
    "protected", "readonly", "static",
};

const py_kw = [_][]const u8{
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
};

const json_kw = [_][]const u8{ "true", "false", "null" };

const shell_kw = [_][]const u8{
    "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
    "esac", "function", "in", "select", "until", "time", "coproc", "return",
    "exit", "export", "local", "readonly", "declare", "typeset", "unset",
};

fn isSpace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r';
}
fn isDigit(c: u8) bool {
    return c >= '0' and c <= '9';
}
fn isHex(c: u8) bool {
    return isDigit(c) or (c >= 'a' and c <= 'f') or (c >= 'A' and c <= 'F');
}
fn isIdentStart(c: u8) bool {
    return (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c == '_' or c == '$';
}
fn isIdentCont(c: u8) bool {
    return isIdentStart(c) or isDigit(c);
}

/// UTF-8 sequence length at `i`, or 1 on invalid/incomplete (degrade, never panic).
fn utf8SeqLen(src: []const u8, i: usize) usize {
    if (i >= src.len) return 1;
    const need = std.unicode.utf8ByteSequenceLength(src[i]) catch return 1;
    if (i + need > src.len) return 1; // incomplete → single-byte degrade
    // Reject overlong/invalid continuation so paint gets 1-byte slices not fake multi-byte.
    _ = std.unicode.utf8Decode(src[i .. i + need]) catch return 1;
    return need;
}

fn eqlIgnoreCase(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        if (std.ascii.toLower(x) != std.ascii.toLower(y)) return false;
    }
    return true;
}

// ── tests ──────────────────────────────────────────────────────────────────

fn hasKind(src: []const u8, family: LangFamily, want: TokenKind) bool {
    var tokens: [128]Token = undefined;
    const n = lexInto(src, family, &tokens);
    for (tokens[0..n]) |t| {
        if (t.kind == want) return true;
    }
    return false;
}

test "isHighlightLang allowlist" {
    try std.testing.expect(isHighlightLang("zig"));
    try std.testing.expect(isHighlightLang(" ZIG "));
    try std.testing.expect(isHighlightLang("c"));
    try std.testing.expect(isHighlightLang("cpp"));
    try std.testing.expect(isHighlightLang("c++"));
    try std.testing.expect(isHighlightLang("hpp"));
    try std.testing.expect(isHighlightLang("typescript"));
    try std.testing.expect(isHighlightLang("js"));
    try std.testing.expect(isHighlightLang("python"));
    try std.testing.expect(isHighlightLang("json"));
    try std.testing.expect(isHighlightLang("bash"));
    try std.testing.expect(!isHighlightLang(null));
    try std.testing.expect(!isHighlightLang(""));
    try std.testing.expect(!isHighlightLang("ziggy"));
    try std.testing.expect(!isHighlightLang("diff"));
    try std.testing.expect(!isHighlightLang("DIFF"));
    try std.testing.expect(!isHighlightLang("patch"));
    try std.testing.expect(!isHighlightLang("rust"));
}

test "zig keywords comment string" {
    const src = "const x = \"hi\"; // note\n";
    try std.testing.expect(hasKind(src, .zig, .keyword));
    try std.testing.expect(hasKind(src, .zig, .string));
    try std.testing.expect(hasKind(src, .zig, .comment));
    var tokens: [64]Token = undefined;
    const n = lexInto(src, .zig, &tokens);
    try std.testing.expect(n > 0);
    // first non-ws token is keyword "const"
    var found_const = false;
    for (tokens[0..n]) |t| {
        if (t.kind == .keyword and std.mem.eql(u8, src[t.start .. t.start + t.len], "const")) {
            found_const = true;
            break;
        }
    }
    try std.testing.expect(found_const);
}

test "c_cpp keywords block comment string number" {
    const src = "int main(void) { /* c */ return 0x2a; }\n";
    try std.testing.expect(hasKind(src, .c_cpp, .keyword));
    try std.testing.expect(hasKind(src, .c_cpp, .comment));
    try std.testing.expect(hasKind(src, .c_cpp, .number));
    var tokens: [64]Token = undefined;
    _ = lexInto(src, .c_cpp, &tokens);
    var found_int = false;
    for (tokens[0..]) |t| {
        if (t.len == 0) break;
        if (t.kind == .keyword and std.mem.eql(u8, src[t.start .. t.start + t.len], "int")) {
            found_int = true;
            break;
        }
    }
    // re-lex properly
    const n = lexInto(src, .c_cpp, &tokens);
    found_int = false;
    for (tokens[0..n]) |t| {
        if (t.kind == .keyword and std.mem.eql(u8, src[t.start .. t.start + t.len], "int")) {
            found_int = true;
            break;
        }
    }
    try std.testing.expect(found_int);
}

test "ecma keyword string" {
    const src = "const foo = \"bar\";\n";
    try std.testing.expect(hasKind(src, .ecma, .keyword));
    try std.testing.expect(hasKind(src, .ecma, .string));
}

test "json string number bool" {
    const src = "{\"a\": 1, \"b\": true, \"c\": null}";
    try std.testing.expect(hasKind(src, .json, .string));
    try std.testing.expect(hasKind(src, .json, .number));
    try std.testing.expect(hasKind(src, .json, .keyword));
}

test "python comment def" {
    const src = "# hi\ndef foo():\n    return 1\n";
    try std.testing.expect(hasKind(src, .python, .comment));
    try std.testing.expect(hasKind(src, .python, .keyword));
}

test "shell comment keywords" {
    const src = "# setup\nif true; then echo hi; fi\n";
    try std.testing.expect(hasKind(src, .shell, .comment));
    try std.testing.expect(hasKind(src, .shell, .keyword));
}

test "unclosed string no panic" {
    const src = "const x = \"unterminated";
    var tokens: [64]Token = undefined;
    const n = lexInto(src, .zig, &tokens);
    try std.testing.expect(n > 0);
    try std.testing.expect(hasKind(src, .zig, .string));
}

test "token coverage contiguous" {
    const src = "fn main() {}";
    var tokens: [64]Token = undefined;
    const n = lexInto(src, .zig, &tokens);
    try std.testing.expect(n > 0);
    try std.testing.expectEqual(@as(usize, 0), tokens[0].start);
    var end: usize = 0;
    for (tokens[0..n]) |t| {
        try std.testing.expectEqual(end, t.start);
        end = t.start + t.len;
    }
    try std.testing.expectEqual(src.len, end);
}

test "utf8 outside string stays whole token" {
    // "x = " + UTF-8 ident bytes (日本語) — not in string/comment
    const src = "x = \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e";
    var tokens: [32]Token = undefined;
    const n = lexInto(src, .python, &tokens);
    try std.testing.expect(n > 0);
    // Every token slice must be valid UTF-8
    for (tokens[0..n]) |t| {
        const slice = src[t.start .. t.start + t.len];
        try std.testing.expect(std.unicode.utf8ValidateSlice(slice));
    }
    // Contiguous full coverage
    var end: usize = 0;
    for (tokens[0..n]) |t| {
        try std.testing.expectEqual(end, t.start);
        end = t.start + t.len;
    }
    try std.testing.expectEqual(src.len, end);
}

test "token buffer cap still paints-safe remainder contract" {
    // Many 1-char tokens; tiny out buffer must not panic and must be contiguous prefix
    const src = "a+b+c+d+e+f+g+h";
    var tokens: [4]Token = undefined;
    const n = lexInto(src, .zig, &tokens);
    try std.testing.expectEqual(@as(usize, 4), n);
    var end: usize = 0;
    for (tokens[0..n]) |t| {
        try std.testing.expectEqual(end, t.start);
        end = t.start + t.len;
        try std.testing.expect(std.unicode.utf8ValidateSlice(src[t.start .. t.start + t.len]));
    }
    try std.testing.expect(end < src.len); // capped before EOF
}

test "utf8 in string and comment" {
    const cjk = "\xe6\x97\xa5\xe6\x9c\xac"; // 日本
    // string: "日"  comment: // 本
    const src = "const s = \"" ++ cjk ++ "\"; // " ++ cjk ++ "\n";
    var tokens: [64]Token = undefined;
    const n = lexInto(src, .zig, &tokens);
    try std.testing.expect(n > 0);
    try std.testing.expect(hasKind(src, .zig, .string));
    try std.testing.expect(hasKind(src, .zig, .comment));
    for (tokens[0..n]) |t| {
        const slice = src[t.start .. t.start + t.len];
        // complete sequences inside string/comment should validate; incomplete only if cap/degrade
        if (t.kind == .string or t.kind == .comment) {
            try std.testing.expect(std.unicode.utf8ValidateSlice(slice));
            try std.testing.expect(std.mem.indexOf(u8, slice, cjk) != null or slice.len > 0);
        }
    }
    // at least one token contains full cjk
    var found = false;
    for (tokens[0..n]) |t| {
        if (std.mem.indexOf(u8, src[t.start .. t.start + t.len], cjk) != null) found = true;
    }
    try std.testing.expect(found);
}

test "lex invalid utf8 does not panic" {
    const src = "a \xe6\x97 b"; // incomplete sequence mid-source
    var tokens: [32]Token = undefined;
    const n = lexInto(src, .zig, &tokens);
    try std.testing.expect(n > 0);
    var end: usize = 0;
    for (tokens[0..n]) |t| {
        try std.testing.expectEqual(end, t.start);
        end = t.start + t.len;
    }
    // may not cover full body if TOKEN buffer tiny — here full
    try std.testing.expectEqual(src.len, end);
}
