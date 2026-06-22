# Interactive diagnostic HUD follow-up

## Goal

Extend the viewer diagnostic work on the `20260622` branch so articulation review is not only a passive report. The new flow should help a reviewer find a likely articulation problem, test it by moving the relevant joint, apply a local repair, re-run diagnostics, and then decide whether to save the repair.

## Implemented flow

1. Add a `Diagnostics` inspector tab beside the existing inspector panels.
2. Classify issues into six reviewer-facing buckets: Joint Type, Axis / Origin, Range, Collision, Semantic, and Hierarchy.
3. Show a target, evidence, and recommended action for every issue.
4. Improve the motion timeline with `min`, `mid`, and `max` pose buttons for each movable joint.
5. Detect suspicious visual-link assignments from URDF visual metadata. In particular, a visual with a name or mesh filename like `outlier`, `fragment`, or `original-123.obj` attached to a root/static link can be flagged when there is a movable child link candidate.
6. Allow the reviewer to queue a visual reassignment, re-run diagnostics against the locally patched URDF model, undo pending repairs, and then save.

## Example target: `data/records/rec_100174`

The motivating case is a small visual such as:

```xml
<visual name="outlier-4">
  <origin xyz="0 0 0"/>
  <geometry>
    <mesh filename="textured_objs/original-135.obj"/>
  </geometry>
</visual>
```

If this visual is attached to `base`, while the object has a movable child driven by `joint_0`, the HUD should raise a Hierarchy issue. The evidence should say that the visual is attached to the static/root-side link, that `joint_0` is the candidate movable child path, and that the outlier-like name or mesh is suspicious.

The intended reviewer loop is:

1. Open `rec_100174` and switch to `Diagnostics`.
2. Use the `joint_0` row in Motion timeline to jump to min/mid/max, or move `joint_0` manually in the Inspect tab.
3. Confirm that `outlier-4` should move with `joint_0`.
4. Click the issue action to move the visual from `base` to the child link of `joint_0`.
5. Confirm the Diagnostics risk drops after the local patch.
6. Save either as a diagnostic version file or overwrite the active materialized URDF.

## Save behavior

The viewer API endpoint is:

```text
POST /api/records/{record_id}/visual-reassignments
```

The request body contains `mode` (`new_version` or `overwrite`) and a list of visual moves. The backend writes a patched URDF plus a JSON patch log under `diagnostic_revisions/`. In `overwrite` mode, it also backs up the current materialized URDF and replaces it with the patched URDF.

## Notes and follow-ups

- The current repair targets materialized viewer URDF files, not the source `model.py` generation script.
- Collision availability is used as supporting evidence in the HUD. A deeper geometric collision or sweep-contact solver can be added later to rank visual moves beyond name/root-link heuristics.
- URL round-tripping for `?tab=diagnostics` should be added by extending the `InspectorTab` union and viewer URL tab allow-list.
