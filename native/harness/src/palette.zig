//! Asteronica palette for dvui — keep hex values in sync with `lib/palette.ts`.
//!
//! TEAL  — chrome / content / primary controls
//! WARM  — intentional amber accent (busy, smoke, assistant label)
//! EMBER — danger / error only
const dvui = @import("dvui");

const Color = dvui.Color;
const Theme = dvui.Theme;

// ── TEAL (lib/palette.ts `teal`) ───────────────────────────────────────────
pub const teal_bg = Color.fromHex("#050a0c");
pub const teal_surface = Color.fromHex("#0a1215");
pub const teal_border = Color.fromHex("#152528");
pub const teal_muted = Color.fromHex("#4a7a80");
pub const teal_text = Color.fromHex("#c0e0e4");
pub const teal_accent = Color.fromHex("#2dd4bf");
pub const teal_accent_dark = Color.fromHex("#14b8a6");
pub const teal_clear = Color.fromHex("#03080a");

// ── WARM (lib/palette.ts `warm`) ───────────────────────────────────────────
pub const warm_bg = Color.fromHex("#120c08");
pub const warm_surface = Color.fromHex("#1a120c");
pub const warm_border = Color.fromHex("#3a2818");
pub const warm_muted = Color.fromHex("#a87850");
pub const warm_text = Color.fromHex("#f0dcc8");
pub const warm_accent = Color.fromHex("#d47c2c");
pub const warm_accent_dark = Color.fromHex("#b86620");

// ── EMBER (lib/palette.ts `ember`) ─────────────────────────────────────────
pub const ember_bg = Color.fromHex("#120a08");
pub const ember_surface = Color.fromHex("#1a100c");
pub const ember_border = Color.fromHex("#3a1e18");
pub const ember_muted = Color.fromHex("#a86050");
pub const ember_text = Color.fromHex("#f0d0c8");
pub const ember_accent = Color.fromHex("#d4412c");
pub const ember_accent_dark = Color.fromHex("#b83420");

/// Full dvui theme: Adwaita Dark fonts + Asteronica colors.
/// Reuses builtin embedded fonts so we don't ship a second font pack.
pub fn theme() Theme {
    var t = Theme.builtin.adwaita_dark;
    t.name = "Asteronica";
    t.dark = true;

    t.focus = teal_accent;
    t.fill = teal_bg;
    t.fill_hover = teal_surface;
    t.fill_press = teal_border;
    t.text = teal_text;
    t.text_hover = teal_text;
    t.text_press = teal_text;
    t.text_select = Color.average(teal_accent, teal_bg);
    t.border = teal_border;

    // Buttons / checkboxes
    t.control = .{
        .fill = teal_surface,
        .fill_hover = teal_border,
        .fill_press = teal_accent_dark,
        .text = teal_text,
        .text_hover = teal_text,
        .text_press = teal_bg,
        .border = teal_border,
    };

    // Window / outer boxes
    t.window = .{
        .fill = teal_bg,
        .fill_hover = teal_bg,
        .fill_press = teal_bg,
        .text = teal_text,
        .border = teal_border,
    };

    // Primary accent (Send, focus targets) — TEAL accent on dark
    t.highlight = .{
        .fill = teal_accent,
        .fill_hover = teal_accent_dark,
        .fill_press = teal_accent_dark,
        .text = teal_bg,
        .text_hover = teal_bg,
        .text_press = teal_bg,
        .border = teal_accent,
    };

    // Danger — EMBER only
    t.err = .{
        .fill = ember_surface,
        .fill_hover = ember_accent_dark,
        .fill_press = ember_accent,
        .text = ember_text,
        .text_hover = ember_text,
        .text_press = ember_text,
        .border = ember_border,
    };

    // WARM family reserved for intentional amber (smoke / busy / assistant)
    t.app1 = .{
        .fill = warm_surface,
        .fill_hover = warm_border,
        .fill_press = warm_accent_dark,
        .text = warm_accent,
        .text_hover = warm_text,
        .text_press = warm_text,
        .border = warm_border,
    };

    // Muted teal chrome (system / secondary labels)
    t.app2 = .{
        .fill = teal_surface,
        .text = teal_muted,
        .border = teal_border,
    };

    // Warm busy strip
    t.app3 = .{
        .fill = warm_surface,
        .text = warm_accent,
        .border = warm_border,
    };

    return t;
}
