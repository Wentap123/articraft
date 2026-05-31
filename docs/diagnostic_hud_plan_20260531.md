# Diagnostic HUD implementation plan

## Goal

Bring the PPT's 3D Articulation Diagnostic HUD concept into the existing Articraft viewer without changing the generation pipeline. The implementation should help reviewers find articulation mistakes directly from the loaded URDF, prompt text, current joint pose, and collision-geometry status.

## Viewer integration

1. Add a new `Diagnostics` inspector tab next to the existing `Inspect`, `Render`, `Code`, and `Metadata` tabs.
2. Keep the current viewer layout intact. Diagnostics should be a right-panel review tool, not a replacement for the kinematic tree or render controls.
3. Reuse the already-loaded URDF joint list, current joint values, selection metadata, prompt files, and collision support state.
4. Keep the panel usable for both persisted records and staging records.

## Diagnostic HUD sections

1. **Risk summary**: show an overall status badge, risk score, joint count, movable joint count, critical issue count, and warning count.
2. **Error taxonomy**: classify issues into joint type, axis/origin, range, collision, semantic mismatch, and hierarchy integrity buckets.
3. **Top evidence**: show the highest-severity issues first, with target, evidence, and recommended action.
4. **Motion timeline**: list every movable revolute, continuous, or prismatic joint as a sweep row and mark suspicious rows.
5. **Prompt consistency**: load `prompt.txt` and compare tracked functional requirements such as rails, hinges, drawers, wheels, handles, and adjustable articulation against detected part and joint names.
6. **Decision workflow**: present a short review path: inspect hierarchy, verify axes/origins, sweep motion, review collision evidence, then accept or repair.

## Rule set

- Flag missing joints as critical.
- Flag incomplete parent/child references and self-referential joints as critical.
- Flag semantic joint-type mismatches, such as hinge-like names using prismatic joints or slider-like names using revolute/continuous joints.
- Flag floating and planar joints as warnings because they are not one-dimensional sweeps.
- Flag missing, degenerate, and non-normalized axes.
- Flag missing pivot origins on non-root movable joints.
- Flag missing or invalid limits on non-continuous movable joints.
- Flag overly broad revolute and prismatic ranges.
- Surface missing collision geometry using the existing collision support signal.
- Compare prompt requirements against the URDF naming corpus and expected joint types.

## Files to update

- `viewer/web/src/components/inspector/DiagnosticsPanel.tsx`: new diagnostic HUD component.
- `viewer/web/src/components/inspector/InspectorTabs.tsx`: wire the new tab and pass URDF, joint values, and collision support.
- `viewer/web/src/lib/types.ts`: add `diagnostics` to the inspector tab union.
- `viewer/web/src/lib/viewer-context.tsx`: allow `tab=diagnostics` to round-trip through the URL.

## Validation plan

- Run `npm run typecheck` in `viewer/web`.
- Run `npm run build` in `viewer/web`.
- Open the viewer, select a persisted record, and confirm the Diagnostics tab renders.
- Select a staging entry and confirm prompt loading and collision status still work.
- Toggle between inspector tabs and reload with `?tab=diagnostics` to confirm URL persistence.
