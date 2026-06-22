#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from storage.identifiers import validate_record_id
from storage.records_index import write_records_index
from storage.repo import StorageRepo
from storage.search import SearchIndex

REVISION_ID = "rev_000001"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def default_record_id(source_dir: Path) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", source_dir.name.strip()) or "mobility"
    if not name.startswith("rec_"):
        name = f"rec_{name}"
    return validate_record_id(name)


def rewrite_mesh_paths(urdf_path: Path, source_dir: Path) -> str:
    text = urdf_path.read_text(encoding="utf-8")
    root = ET.fromstring(text)
    changed = False
    for mesh in root.iter("mesh"):
        filename = mesh.attrib.get("filename")
        if not filename:
            continue
        rewritten = filename
        if filename.startswith("package://"):
            match = re.match(r"^package://[^/]+/(.+)$", filename)
            if match:
                rewritten = match.group(1)
        elif filename.startswith("file://"):
            rewritten = filename.removeprefix("file://")
        path = Path(rewritten)
        if path.is_absolute():
            try:
                rewritten = path.resolve().relative_to(source_dir.resolve()).as_posix()
            except ValueError:
                rewritten = path.name
        if rewritten != filename:
            mesh.set("filename", rewritten)
            changed = True
    return ET.tostring(root, encoding="unicode") if changed else text


def copy_tree(source_dir: Path, record_dir: Path, overwrite: bool) -> None:
    if record_dir.exists():
        if not overwrite:
            raise FileExistsError(f"Record already exists: {record_dir}. Use --overwrite to replace it.")
        shutil.rmtree(record_dir)
    record_dir.mkdir(parents=True)
    for child in source_dir.iterdir():
        target = record_dir / child.name
        if child.is_dir():
            shutil.copytree(child, target)
        else:
            shutil.copy2(child, target)


def write_record_metadata(repo: StorageRepo, record_id: str, source_dir: Path, title: str, prompt: str, urdf_text: str) -> None:
    now = utc_now()
    record_dir = repo.layout.record_dir(record_id)
    revision_dir = repo.layout.record_revision_dir(record_id, REVISION_ID)
    prompt_text = prompt.strip() or f"Imported Mobility URDF asset from {source_dir.name}."
    model_text = (
        '"""Imported URDF-only record.\n\n'
        'The viewer asset lives in data/cache/record_materialization.\n'
        'This stub exists to satisfy the Articraft record format.\n'
        '"""\n\n'
        'def build_model():\n'
        f'    raise RuntimeError("{record_id} is an imported URDF-only record")\n'
    )
    artifacts = {
        "prompt_txt": f"revisions/{REVISION_ID}/prompt.txt",
        "prompt_series_json": None,
        "model_py": f"revisions/{REVISION_ID}/model.py",
        "provenance_json": f"revisions/{REVISION_ID}/provenance.json",
        "cost_json": None,
        "inputs_dir": f"revisions/{REVISION_ID}/inputs",
        "traces_dir": None,
    }
    hashes = {
        "prompt_sha256": sha256_text(prompt_text + "\n"),
        "model_py_sha256": sha256_text(model_text),
    }
    source = {"run_id": None, "prompt_batch_id": None, "batch_spec_id": None, "row_id": None, "prompt_index": None}
    generation = {
        "provider": None,
        "model_id": None,
        "thinking_level": None,
        "openai_transport": None,
        "openai_reasoning_summary": None,
        "max_turns": None,
        "max_cost_usd": None,
    }
    run_summary = {"turn_count": None, "tool_call_count": None, "compile_attempt_count": None, "final_status": "success"}

    write_text(revision_dir / "prompt.txt", prompt_text + "\n")
    write_text(revision_dir / "model.py", model_text)
    (revision_dir / "inputs").mkdir(parents=True, exist_ok=True)
    write_json(revision_dir / "provenance.json", {
        "schema_version": 2,
        "record_id": record_id,
        "generation": generation,
        "prompting": {"system_prompt_file": "import_mobility_record.py", "system_prompt_sha256": None},
        "sdk": {"sdk_package": "sdk", "sdk_version": "imported-urdf", "sdk_fingerprint": None},
        "environment": {"python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}", "platform": sys.platform, "git_commit": None, "uv_lock_sha256": None},
        "run_summary": run_summary,
    })
    write_json(revision_dir / "revision.json", {
        "schema_version": 1,
        "record_id": record_id,
        "revision_id": REVISION_ID,
        "created_at": now,
        "prompt_kind": "single_prompt",
        "prompt_sha256": hashes["prompt_sha256"],
        "source": source,
        "generation": generation,
        "artifacts": artifacts,
        "hashes": hashes,
        "run_summary": run_summary,
        "parent": None,
        "seed": None,
        "inherited_inputs": [],
    })
    write_json(record_dir / "record.json", {
        "schema_version": 3,
        "record_id": record_id,
        "created_at": now,
        "updated_at": now,
        "rating": None,
        "secondary_rating": None,
        "author": None,
        "rated_by": None,
        "secondary_rated_by": None,
        "kind": "imported_urdf",
        "prompt_kind": "single_prompt",
        "category_slug": None,
        "source": source,
        "sdk_package": "sdk",
        "provider": None,
        "model_id": None,
        "display": {"title": title or record_id, "prompt_preview": prompt_text},
        "artifacts": artifacts,
        "hashes": hashes,
        "collections": [],
        "active_revision_id": REVISION_ID,
        "lineage": {"origin_record_id": None, "parent_record_id": None},
        "creator": {"mode": "external_agent", "agent": "codex", "trace_available": False},
    })
    materialization_dir = repo.layout.record_materialization_dir(record_id)
    materialization_dir.mkdir(parents=True, exist_ok=True)
    write_text(repo.layout.record_materialization_urdf_path(record_id), urdf_text)
    mesh_count = sum(1 for _ in ET.fromstring(urdf_text).iter("mesh"))
    write_json(repo.layout.record_materialization_compile_report_path(record_id), {
        "schema_version": 1,
        "record_id": record_id,
        "status": "imported",
        "urdf_path": "model.urdf",
        "warnings": [],
        "checks_run": ["import_mobility_urdf"],
        "overlap_allowances": [],
        "metrics": {"compile_level": "visual", "validation_level": "none", "materialization_status": "available", "visual_mesh_file_count": mesh_count, "visual_mesh_bytes": 0},
    })


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a PartNet-Mobility style URDF directory as an Articraft viewer record.")
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--record-id")
    parser.add_argument("--urdf", default="mobility.urdf")
    parser.add_argument("--title", default="")
    parser.add_argument("--prompt", default="")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    try:
        repo = StorageRepo(args.repo_root)
        repo.ensure_layout()
        source_dir = args.source_dir.expanduser().resolve()
        if not source_dir.is_dir():
            raise FileNotFoundError(f"Source directory not found: {source_dir}")
        record_id = validate_record_id(args.record_id or default_record_id(source_dir))
        urdf_path = (source_dir / args.urdf).resolve()
        if not urdf_path.is_file():
            raise FileNotFoundError(f"URDF file not found: {urdf_path}")
        urdf_text = rewrite_mesh_paths(urdf_path, source_dir)
        record_dir = repo.layout.record_dir(record_id)
        copy_tree(source_dir, record_dir, args.overwrite)
        write_text(record_dir / "model.urdf", urdf_text)
        write_record_metadata(repo, record_id, source_dir, args.title or source_dir.name, args.prompt, urdf_text)
        rows = write_records_index(repo)
        stats = SearchIndex(repo).rebuild()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Imported record_id={record_id}")
    print(f"record_dir={record_dir}")
    print(f"viewer_url=/viewer?record={record_id}")
    print(f"records_index_rows={len(rows)}")
    print(f"search_index={stats.path} records={stats.record_count} categories={stats.category_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
