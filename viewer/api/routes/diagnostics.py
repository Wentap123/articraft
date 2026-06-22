from __future__ import annotations

import json
import math
import shutil
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from storage.identifiers import validate_record_id
from viewer.api.dependencies import FileResolverDep, ViewerStoreDep

router = APIRouter()

Vec3 = tuple[float, float, float]


class VisualReassignmentMove(BaseModel):
    source_link: str = Field(min_length=1)
    target_link: str = Field(min_length=1)
    visual_index: int = Field(ge=0)
    visual_name: str | None = None
    origin_xyz: Vec3 | None = None
    origin_rpy: Vec3 | None = None
    reason: str | None = None

    @field_validator("source_link", "target_link", "visual_name", "reason")
    @classmethod
    def _strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("origin_xyz", "origin_rpy", mode="before")
    @classmethod
    def _validate_vec3(cls, value: object) -> Vec3 | None:
        if value is None:
            return None
        if not isinstance(value, (list, tuple)) or len(value) != 3:
            raise ValueError("origin vectors must contain exactly 3 numbers")
        parsed = tuple(float(item) for item in value)
        if not all(math.isfinite(item) for item in parsed):
            raise ValueError("origin vectors must contain finite numbers")
        return parsed  # type: ignore[return-value]


class VisualReassignmentRequest(BaseModel):
    mode: str = Field(default="new_version")
    moves: list[VisualReassignmentMove] = Field(min_length=1, max_length=100)

    @field_validator("mode")
    @classmethod
    def _validate_mode(cls, value: str) -> str:
        mode = value.strip()
        if mode not in {"overwrite", "new_version"}:
            raise ValueError("mode must be overwrite or new_version")
        return mode


class VisualReassignmentResponse(BaseModel):
    status: str
    record_id: str
    mode: str
    applied_count: int
    active_file_path: str | None = None
    version_file_path: str
    patch_file_path: str
    asset_revision_key: str


def _validate_record_id(record_id: str) -> None:
    try:
        validate_record_id(record_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid record ID format") from exc


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _relative_to_repo(repo_root: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(repo_root.resolve()))
    except ValueError:
        return str(path)


def _direct_children(element: ET.Element, tag_name: str) -> list[ET.Element]:
    return [child for child in list(element) if child.tag.rsplit("}", 1)[-1] == tag_name]


def _find_link(root: ET.Element, link_name: str) -> ET.Element | None:
    for link in _direct_children(root, "link"):
        if link.get("name") == link_name:
            return link
    return None


def _format_vec3(value: Vec3) -> str:
    return " ".join(f"{item:.12g}" for item in value)


def _set_visual_origin(visual: ET.Element, xyz: Vec3 | None, rpy: Vec3 | None) -> None:
    if xyz is None and rpy is None:
        return
    origins = _direct_children(visual, "origin")
    origin = origins[0] if origins else None
    if origin is None:
        origin = ET.Element("origin")
        visual.insert(0, origin)
    if xyz is not None:
        origin.set("xyz", _format_vec3(xyz))
    if rpy is not None:
        origin.set("rpy", _format_vec3(rpy))


def _apply_visual_reassignments(
    urdf_xml: str,
    moves: list[VisualReassignmentMove],
) -> tuple[str, list[dict[str, object]]]:
    try:
        root = ET.fromstring(urdf_xml)
    except ET.ParseError as exc:
        raise HTTPException(status_code=400, detail=f"URDF parse failed: {exc}") from exc

    applied: list[dict[str, object]] = []
    ordered_moves = sorted(moves, key=lambda item: (item.source_link, -item.visual_index))
    for move in ordered_moves:
        source = _find_link(root, move.source_link)
        target = _find_link(root, move.target_link)
        if source is None:
            raise HTTPException(status_code=400, detail=f"Source link not found: {move.source_link}")
        if target is None:
            raise HTTPException(status_code=400, detail=f"Target link not found: {move.target_link}")

        visuals = _direct_children(source, "visual")
        if move.visual_index >= len(visuals):
            raise HTTPException(
                status_code=400,
                detail=f"Visual index {move.visual_index} is out of range for {move.source_link}",
            )
        visual = visuals[move.visual_index]
        actual_name = visual.get("name")
        if move.visual_name and actual_name and actual_name != move.visual_name:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Visual name mismatch for {move.source_link}[{move.visual_index}]: "
                    f"expected {move.visual_name}, found {actual_name}"
                ),
            )

        _set_visual_origin(visual, move.origin_xyz, move.origin_rpy)
        source.remove(visual)
        target.append(visual)
        applied.append(
            {
                "source_link": move.source_link,
                "target_link": move.target_link,
                "visual_index": move.visual_index,
                "visual_name": actual_name,
                "origin_xyz": list(move.origin_xyz) if move.origin_xyz is not None else None,
                "origin_rpy": list(move.origin_rpy) if move.origin_rpy is not None else None,
                "reason": move.reason,
            }
        )

    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="unicode"), applied


@router.post(
    "/api/records/{record_id}/visual-reassignments",
    response_model=VisualReassignmentResponse,
)
async def apply_visual_reassignments(
    record_id: str,
    payload: VisualReassignmentRequest,
    store: ViewerStoreDep,
    resolver: FileResolverDep,
) -> VisualReassignmentResponse:
    _validate_record_id(record_id)
    _, urdf_path = await resolver.resolve_record_target_with_materialization(record_id, "model.urdf")
    urdf_xml = urdf_path.read_text(encoding="utf-8")
    patched_xml, applied = _apply_visual_reassignments(urdf_xml, payload.moves)

    stamp = _utc_stamp()
    version_root = urdf_path.parent / "diagnostic_revisions"
    version_root.mkdir(parents=True, exist_ok=True)
    version_path = version_root / f"model_visual_reassign_{stamp}.urdf"
    patch_path = version_root / f"visual_reassign_{stamp}.json"

    version_path.write_text(patched_xml, encoding="utf-8")
    patch_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "record_id": record_id,
                "mode": payload.mode,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "active_urdf_path": _relative_to_repo(store.repo_root, urdf_path),
                "version_urdf_path": _relative_to_repo(store.repo_root, version_path),
                "moves": applied,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    active_file_path: str | None = None
    if payload.mode == "overwrite":
        backup_path = version_root / f"model_before_visual_reassign_{stamp}.urdf"
        shutil.copy2(urdf_path, backup_path)
        urdf_path.write_text(patched_xml, encoding="utf-8")
        active_file_path = _relative_to_repo(store.repo_root, urdf_path)

    return VisualReassignmentResponse(
        status="saved",
        record_id=record_id,
        mode=payload.mode,
        applied_count=len(applied),
        active_file_path=active_file_path,
        version_file_path=_relative_to_repo(store.repo_root, version_path),
        patch_file_path=_relative_to_repo(store.repo_root, patch_path),
        asset_revision_key=stamp,
    )
