# Design QA

## Comparison target

- Source visual truth:
  - Settings: `C:\Users\30376\Downloads\ChatGPT Image 2026年7月23日 19_44_42 (1).png`
  - Popup structure: `C:\Users\30376\Downloads\ChatGPT Image 2026年7月23日 19_44_42 (2).png`
  - Popup size: `D:\fycj\youtube-deepseek-translator-v1.0.0.zip` (`popup.css` specifies a `360px` body; the recreated configured state renders at `360 × 396` CSS px)
  - Popup edge treatment issue: `C:\Users\30376\AppData\Local\Temp\codex-clipboard-e1ff0596-3ae0-4b15-96ec-84c730e95f7b.png`
  - Subtitle-mode control issues: `C:\Users\30376\AppData\Local\Temp\codex-clipboard-bf1b7683-f685-4699-a504-31ed1ff54f96.png` and `C:\Users\30376\AppData\Local\Temp\codex-clipboard-30ddb3c0-ccea-4b8d-87a6-c8a84762c2b2.png`
  - Settings dropdown alignment issue: `C:\Users\30376\AppData\Local\Temp\codex-clipboard-6cc7299f-48df-4853-9733-30e690a672c7.png`
  - Extension cover artwork: `C:\Users\30376\Downloads\ChatGPT Image 2026年7月23日 19_08_35.png`
- Browser-rendered implementation:
  - Settings: `D:\fycj\tests\design-qa\options-implementation.png`
  - Popup: `D:\fycj\tests\design-qa\popup-edge-to-edge-implementation.png`
  - Narrow subtitle-mode control: `D:\fycj\tests\design-qa\options-mode-mobile-after-bilingual.png`
  - Final dropdown arrow position: `D:\fycj\tests\design-qa\options-target-arrow-left.png`
  - Extension cover and icon set: `D:\fycj\tests\design-qa\extension-cover-icon-comparison.png`
- Intentional deviation: the source screenshots use a light green palette, while the implementation keeps the existing YouTube dark palette (`#0f0f0f`, `#212121`, white/gray text, `#ff0033`) per the user's explicit request.

## Viewport and normalization

- Browser viewport: `2560 × 1600` CSS px; screenshot and CSS pixels were observed at 1:1 density.
- Settings source: `1055 × 1491` px. It was normalized to `1056 × 1508` px for comparison.
- Settings implementation: shell measured `1056 × 1507.625` CSS px and was cropped to `1056 × 1508` px.
- Popup structure source: `1254 × 1254` px full canvas. The visible card was cropped and normalized to the requested v1.0 size of `360 × 396` px.
- Popup size source: the v1.0 configured-state recreation measured `360 × 396` CSS px.
- Popup implementation: `body` and the edge-to-edge popup surface both measured exactly `360 × 396` CSS px.
- Narrow settings checks used `650 × 509` and `720 × 509` browser captures. The real `705px` client-width page reported `705/705` scroll/client width with no horizontal overflow.
- Final dropdown-arrow before/after captures both use the same `705 × 509` browser viewport at 1:1 density. A second responsive check used a `613px` client width and also reported equal scroll/client widths.
- Cover source: `1254 × 1254` px; the packaged cover is `512 × 512` px, with manifest icons at `16`, `32`, `48`, and `128` px.
- State:
  - Settings: enabled, masked configured key, full-track prefetch enabled, bilingual display, default display values.
  - Popup: enabled, non-YouTube empty state.

## Comparison evidence

- Settings full view: `D:\fycj\tests\design-qa\options-comparison.png`
- Settings focused header/connection region: `D:\fycj\tests\design-qa\options-header-connection-comparison.png`
- Popup structure at v1 size: `D:\fycj\tests\design-qa\popup-design-v1-size-comparison.png`
- Popup v1 size truth versus implementation: `D:\fycj\tests\design-qa\popup-v1-size-comparison.png`
- Popup edge-to-edge before/after: `D:\fycj\tests\design-qa\popup-edge-to-edge-before-after.png`
- Subtitle-mode before/after: `D:\fycj\tests\design-qa\options-mode-before-after.png`
- Dropdown alignment at the same viewport: `D:\fycj\tests\design-qa\options-dropdown-shift-comparison.png`
- Focused dropdown-arrow before/after: `D:\fycj\tests\design-qa\options-arrow-left-comparison.png`
- Extension cover and icon output: `D:\fycj\tests\design-qa\extension-cover-icon-comparison.png`

The popup is a `360 × 396` surface, so its full-card comparison is also the focused comparison. No smaller crop was needed to judge its typography, icons, card spacing, controls, and empty-state artwork.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography: the implementation preserves the source hierarchy, weights, compact helper text, line wrapping, and title scale using an Inter/PingFang/Microsoft YaHei/system fallback stack. No clipping or truncation was observed.
- Spacing and layout rhythm: major regions, two-column settings grids, card padding, popup summary columns, button proportions, radii, and vertical rhythm align with the normalized source. The settings implementation is less than one CSS pixel from the normalized target height. The popup now matches the first release's exact `360 × 396` outer size while retaining the current card hierarchy.
- Colors and visual tokens: the light-green source palette was intentionally remapped to the existing YouTube dark tokens. Red remains reserved for primary actions, active controls, and status accents; disabled controls remain visually distinct. The body and outer popup now share the exact `rgb(24, 24, 24)` surface token so no black perimeter is visible.
- Image quality and asset fidelity: the settings preview uses a sharp `1280 × 720` raster asset at a 16:9 crop. The popup empty state uses a dedicated `500 × 300` dark raster asset. Interface icons, including the new dropdown chevron, come from one consistent Tabler icon family. The supplied cover artwork is preserved without cropping in the packaged `512px` cover and all four Chrome icon sizes; the small icons remain recognisable through the central red play mark.
- Copy and content: the labels and helper text keep the source information architecture while accurately describing the extension's existing prefetch-first and realtime-fallback behavior.
- Accessibility and states: inputs retain labels, image icons are decorative with empty alternative text, focus styles are present, active/disabled states are distinct, and responsive rules exist at `900px` and `680px`. Both subtitle-mode states now draw a complete active outline, including the shared center edge and outer rounded corners.
- Dropdown alignment: the model and target-language boxes are restored to their prior `4px` left offset and measure `x = 42`, `width = 289.5` at the `705px` client width. Only the internal arrows move left: both arrow rectangles measure `x = 293.5`, `width = 18`, leaving `20px` between the icon's right edge and the select border.
- Responsive check: at the `613px` client width, the target-language box measured `x = 25`, `right = 580`; its arrow measured `x = 542`, `right = 560`. Scroll and client widths both remained `613px`, so the custom arrow introduced no clipping or overflow.

## Primary interactions tested

- Settings:
  - Switching from bilingual to translation-only updates the configuration overview.
  - Switching back to bilingual restores the overview and complete left-segment active outline.
  - Reset restores bilingual mode, `30 px` font size, and `420 ms` realtime segmentation delay.
  - Save reports success in local preview mode.
  - Connection test updates the connection and last-test states.
  - Selecting V4 Pro and English updates the configuration overview; restoring V4 Flash and 简体中文 also succeeds with the custom arrow layer present.
- Popup:
  - Main switch pauses and re-enables translation state.
  - Disabled retranslation state remains non-interactive when no YouTube video is active.
  - Open-settings control produces no runtime error in preview mode.
  - `body` reports `360/360` scroll/client width and `396/396` scroll/client height, with no overflow.
- Error checks: `window.error` and `unhandledrejection` hooks reported an empty error list on both pages after the tested interactions.

## Comparison history

1. Initial settings pass:
   - P2: implementation shell was approximately `1056 × 1594`, materially taller than the `1055 × 1491` source.
   - P2: muted utility icons had insufficient contrast on the dark surface.
   - Fixes: tightened vertical padding and section gaps; increased the muted icon brightness filter.
   - Post-fix evidence: `D:\fycj\tests\design-qa\options-comparison.png`, final shell `1056 × 1507.625` CSS px.
2. Initial popup pass:
   - P2: implementation was `532 × 573`, making the card visibly taller and less square than the source.
   - Fix: reduced header, card, action, and footer vertical spacing without changing content or behavior.
   - Post-fix evidence: `D:\fycj\tests\design-qa\popup-comparison.png`, final popup `532 × 533` CSS px.
3. Compact-popup follow-up:
   - User feedback: the `532 × 533` popup felt too large.
   - P2 in the first compact pass: width was reduced to `476` CSS px, but the height compressed to `456` CSS px and drifted from the source's near-square proportion.
   - Fix: kept the `476` CSS px outer width while proportionally restoring header, illustration, cards, actions, and footer rhythm.
   - Post-fix evidence: `D:\fycj\tests\design-qa\popup-compact-comparison.png` and `D:\fycj\tests\design-qa\popup-size-before-after.png`; final popup `476 × 477` CSS px with no overflow.
4. Original-size restoration:
   - User feedback requested returning to the original popup size.
   - Fix: restored `popup.css` exactly to the accepted v1.7.0 contents; direct text comparison returned an exact match.
   - Post-fix evidence: `D:\fycj\tests\design-qa\popup-restored-comparison.png`; browser rendering returned to `532 × 533` CSS px. The restored full screenshot is byte-for-byte identical to the earlier accepted screenshot.
5. First-release size correction:
   - User clarified that “original” meant the first v1.0.0 release, not the pre-compact v1.7.0 design.
   - Evidence: v1.0.0 `popup.css` sets `body { width: 360px; }`; a browser recreation of its configured state measured `360 × 396` CSS px.
   - Fix: resized the current popup's body, spacing, type scale, illustration, summary, and actions individually; no transform scaling was used. The body uses explicit padding/min-height to avoid margin collapse and match the reference dimensions exactly.
   - Post-fix evidence: `D:\fycj\tests\design-qa\popup-design-v1-size-comparison.png` and `D:\fycj\tests\design-qa\popup-v1-size-comparison.png`; final body `360 × 396` CSS px with no overflow.
6. Edge-to-edge background correction:
   - User evidence showed a black perimeter around a rounded gray outer popup card.
   - Fix: removed body padding and the outer popup border, radius, shadow, and red radial treatment; applied the current gray surface token to both body and popup.
   - Post-fix evidence: `D:\fycj\tests\design-qa\popup-edge-to-edge-before-after.png`; both body and popup measure `360 × 396` CSS px from `(0, 0)` and report the same `rgb(24, 24, 24)` background.
7. Subtitle-mode and dropdown alignment correction:
   - User evidence showed that the selected segment outline could appear incomplete and that the two selects sat too far right.
   - Fix: gave each segment its own full transparent border and side-specific corner radii, used the YouTube-red border for the checked state, and shifted the model and target-language selects `4px` left.
   - Post-fix evidence: `D:\fycj\tests\design-qa\options-mode-before-after.png`; bilingual and translation-only states were both exercised, and the page retained zero horizontal overflow.
8. Extension cover integration:
   - User supplied a square “Video Translate” artwork for the extension cover.
   - Fix: preserved the full square composition in a `512px` packaged cover, generated Chrome-compatible `16`, `32`, `48`, and `128px` PNG variants, and wired both manifest-level and toolbar action icons.
   - Post-fix evidence: `D:\fycj\tests\design-qa\extension-cover-icon-comparison.png`.
9. Dropdown alignment follow-up:
   - User feedback: the initial `4px` shift was too subtle to notice.
   - Fix: increased the total left offset to `12px`, producing an additional visible `8px` movement while keeping a safe inset at the `613px` responsive viewport.
   - Post-fix evidence: `D:\fycj\tests\design-qa\options-dropdown-shift-comparison.png`; model and target-language controls were compared at identical viewport and scroll states, with no horizontal overflow.
10. Dropdown-arrow clarification:
   - User clarified that the requested movement applied to the arrow icons, not the dropdown boxes.
   - Fix: restored both boxes to their accepted `4px` offset, replaced the browser-controlled chevrons with the matching Tabler chevron asset, and positioned only those icons `20px` from the right border.
   - Post-fix evidence: `D:\fycj\tests\design-qa\options-arrow-left-comparison.png`; both boxes retain their prior geometry while the arrows visibly move left, the selects remain interactive, and no responsive overflow appears.

## Open Questions

- None. The only large stylistic difference from the source—the dark YouTube palette—is an explicit product requirement.

## Implementation Checklist

- [x] Match settings-page structure and proportions.
- [x] Match popup structure at the first release's `360 × 396` size.
- [x] Fill the popup edge-to-edge with the current gray surface.
- [x] Preserve YouTube dark palette.
- [x] Keep both subtitle-mode selected outlines complete, restore the dropdown boxes, and move only their arrow icons left without overflow.
- [x] Use the supplied artwork for the packaged extension cover and manifest icon set.
- [x] Keep all existing settings and translation behavior wired.
- [x] Verify primary controls and empty/disabled states.
- [x] Run browser error hooks and visual comparison.

## Follow-up Polish

- No blocking polish remains.

final result: passed
