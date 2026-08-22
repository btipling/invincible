//! Named chrome constants shared by the facade + ui/* paint files.
//! No product-side imports — pure values only (plan #656).

/// Touch-friendly control height (CSS px ≈).
pub const TOUCH_H: f32 = 40;
/// Near-bottom epsilon for stick-to-bottom follow (plan #135).
pub const NEAR_BOTTOM_PX: f32 = 48;
/// Ignore subpixel layout noise when detecting in-place stream growth (#251).
pub const CONTENT_GREW_EPS: f32 = 1.0;
/// Reserved bottom chrome: single-row textEntry + trailing TOUCH_H icon + margins
/// (plan #457 — replaces the old textEntry + Send/Stop action row from plan #138).
/// Per-edge margin between textEntry content rect and composer-chrome box edge
/// (Options.padding.y). Plan #579 replaces the old fixed COMPOSER_PAD_Y (4 px
/// top-only) with 2 px per edge on the new dynamic hug box.
pub const COMPOSER_HUG_PAD: f32 = 2;
/// Inset between glyphs and the textEntry's teal border (px). #584 zeroed this
/// so dvui's padding-bake would not double-count in the outer→content convert;
/// glyphs then sat on the stroke. 5 px is the operator ask after #584 shipped.
/// Passed as textEntry Options.padding — TextEntryWidget.init bakes it into
/// min/max_size_content then nulls the option, so we subtract 2× this from
/// those sizes to keep the 44/124 chrome caps.
pub const COMPOSER_TE_PAD: f32 = 5;
/// Multi-line composer visible-height cap (px). Wrapped lines grow the entry up
/// to this, then it scrolls vertically **inside** the entry — never a horizontal
/// gutter past the trailing icon (plan #457, repo no-h-scroll policy). The
/// composer-chrome box caps at COMPOSER_INPUT_MAX_H + 2*COMPOSER_HUG_PAD via
/// max_size_content; taller pasted content scrolls internally (plan #334 / #323).
pub const COMPOSER_INPUT_MAX_H: f32 = 120;
/// Absolute floor so a short canvas still has a scroll band.
pub const SCROLL_FLOOR_H: f32 = 32;
/// Status-bar band height (px) — a two-line always-mounted full-width strip painted
/// directly BELOW the composer (plan #555 → #554, header merged by plan #570).
/// Reserved into the bottom chrome budget so the transcript never overlaps it and
/// the transcript+composer stack never jumps vertically when a sandbox attaches.
/// 64 px = two 32 px rows, exactly fitting the model picker (PICKER_TRIGGER_H = 32) + status slots.
/// Total chrome (64) ≤ old header+bar (92) — net −28 px transcript gain (plan #570).
pub const STATUS_BAR_H: f32 = 64;

/// Maximum composer-chrome outer height (px). The composer box rect grows up to
/// this from idle hug (~44 px) via previous-frame measured height. Multi-line
/// content past this cap scrolls internally (plan #457). The rect is still
/// absolute (Options.rect), so the scrollArea never publishes virtual content
/// height into the root flex (dvui `.auto` bar overwrites min_size.h —
/// adversarial review #584 Blocker L1).
pub const COMPOSER_MAX_CHROME_H: f32 = COMPOSER_INPUT_MAX_H + 2 * COMPOSER_HUG_PAD;
/// Idle composer-chrome outer height (px) when the field is a single line.
/// TOUCH_H (40) + 2 px top + 2 px bottom padding = 44 px. The composer band
/// is never smaller than this so the textEntry always has a touch target.
pub const COMPOSER_IDLE_CHROME_H: f32 = TOUCH_H + 2 * COMPOSER_HUG_PAD;

/// TextEntry border overhead (px). The textEntry's computed min_size (via
/// dvui.minSizeGet after deinit) is the OUTER height (content + border).
/// dvui TextEntryWidget.init *bakes* options.padding into min_size_content
/// and nulls options.padding, so minSizeGet adds border only (2) — NOT
/// padding. We convert outer→content: content_h = outer_h − TE_OVERHEAD.
/// Border is set explicitly on the textEntry below. Padding is COMPOSER_TE_PAD
/// (5); we pass min/max_size_content *already minus* 2×TE_PAD so the bake
/// restores the named 40/120 wells and the 44/124 chrome caps (#584 squeeze
/// was subtracting pad *again* from a post-null minSizeGet).
pub const TE_BORDER_H: f32 = 1 + 1; // border.y + border.h
pub const TE_OVERHEAD: f32 = TE_BORDER_H; // 2

/// Sticky last-user-message chip (plan #645, source issue #339).
pub const CHIP_VISIBILITY_MARGIN: f32 = 8;

/// Submit-queue band (plan #664): header + up to this many visible rows.
pub const QUEUE_BAND_MAX_ROWS: u32 = 3;

/// Help overlay (plan #741 → #781): a modal in-canvas subwindow that fills most
/// of the transcript band. The fixed 460×320 cap (`HELP_OVERLAY_W/H`) is
/// retired (human-approved cap change 2026-08-22) in favor of named band
/// fractions + small absolute floors. Pure visual-paint metric — no wire or
/// transport ceiling (the panel never exceeds the band rect; a scrollArea
/// handles internal overflow).
///
/// Panel size (width-first): `min(max(fraction·band, floor), band − 2·margin)`.
/// The floor keeps a ~390 px canvas on-canvas with no horizontal overflow; it is
/// clamped away when the band sits near the MIN gate (matches the repo no-h-scroll
/// policy already applied to composer chrome).
pub const HELP_OVERLAY_W_FRACTION: f32 = 0.92;
pub const HELP_OVERLAY_H_FRACTION: f32 = 0.86;
/// Min band size under which the overlay is not painted.
pub const HELP_OVERLAY_MIN_W: f32 = 300;
pub const HELP_OVERLAY_MIN_H: f32 = 200;
/// Absolute floor so a ~390 px canvas still gets a usable on-canvas panel.
pub const HELP_OVERLAY_FLOOR_W: f32 = 360;
pub const HELP_OVERLAY_FLOOR_H: f32 = 240;
/// Margin from the transcript band edges (keeps the panel off the rail / bars).
pub const HELP_OVERLAY_MARGIN_X: f32 = 16;
pub const HELP_OVERLAY_MARGIN_Y: f32 = 16;
/// Fixed (min) width of the chord column in the two-column help table. Every
/// chord textLayout gets this min width so every help string starts on a stable x.
pub const HELP_OVERLAY_CHORD_COL_W: f32 = 140;

/// Gap (px) added to each slot's measured text width — matches the `margin.w`
/// on each slot textLayout below, so the budget math equals the paint exactly.
pub const STATUS_SLOT_GAP: f32 = 10;
/// Extra pad subtracted from the pack budget so the reservation never races
/// live-layout rounding (a couple px either way must not push a primary control).
pub const STATUS_PACK_BUDGET_SAFETY: f32 = 4;
