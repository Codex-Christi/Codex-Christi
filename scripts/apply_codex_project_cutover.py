#!/usr/bin/env python3
"""Apply a recoverable offline sidebar cutover for migrated Codex tasks.

The desktop app must be fully closed. Source tasks remain intact and keep their
project slots. Each verified current-provider fork is placed immediately after
its source, so either provider retains the same project grouping and order.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from typing import Any

import migrate_codex_project_history as migration


DESKTOP_WRITER_EXECUTABLES = (
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "/Applications/Codex.app/Contents/MacOS/Codex",
)
JOURNAL_NAME = "cutover-journal.json"
APPLIED_STATUS = "cutover_applied_pending_restart_verification"
FINAL_STATUS = "cutover_verified"
TERMINAL_JOURNAL_PHASES = {
    "abandoned_prepared",
    "rolled_back",
    "rollback_recovered",
    APPLIED_STATUS,
    FINAL_STATUS,
}
SECTION_FIELDS = {
    "thread_section_id",
    "section_position",
    "section_entered_at_ms",
}


def desktop_processes() -> list[str]:
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if any(executable in line for executable in DESKTOP_WRITER_EXECUTABLES)
    ]


def database_holders(codex_home: Path) -> list[str]:
    database = migration.state_database(codex_home)
    targets = [database]
    for suffix in ("-wal", "-shm"):
        candidate = Path(f"{database}{suffix}")
        if candidate.exists():
            targets.append(candidate)
    result = subprocess.run(
        ["/usr/sbin/lsof", "-t", *map(str, targets)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in {0, 1} or (result.returncode == 1 and result.stderr.strip()):
        raise migration.MigrationError(
            "Could not prove the state database is offline: "
            + (result.stderr.strip() or f"lsof exited {result.returncode}")
        )
    pids = sorted(
        {
            int(line)
            for line in result.stdout.splitlines()
            if line.strip().isdigit() and int(line) != os.getpid()
        }
    )
    holders: list[str] = []
    for pid in pids:
        process = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "pid=,command="],
            check=False,
            capture_output=True,
            text=True,
        ).stdout.strip()
        holders.append(process or str(pid))
    if result.returncode == 0 and not holders:
        raise migration.MigrationError("lsof reported holders but returned no process IDs")
    return holders


def offline_conflicts(codex_home: Path) -> list[str]:
    return sorted(set(desktop_processes() + database_holders(codex_home)))


def assert_offline(codex_home: Path) -> None:
    conflicts = offline_conflicts(codex_home)
    if conflicts:
        raise migration.MigrationError(
            "ChatGPT/Codex or another state-database writer is running: "
            + " | ".join(conflicts)
        )


def wait_until_offline(codex_home: Path, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    clear_since: float | None = None
    last_conflicts: list[str] = []
    while time.monotonic() < deadline:
        last_conflicts = offline_conflicts(codex_home)
        if last_conflicts:
            clear_since = None
        else:
            clear_since = clear_since or time.monotonic()
            if time.monotonic() - clear_since >= 3:
                return
        time.sleep(1)
    raise migration.MigrationError(
        "Timed out waiting for ChatGPT/Codex to close"
        + (": " + " | ".join(last_conflicts) if last_conflicts else "")
    )


def encoded_sqlite_cell(value: Any) -> list[Any]:
    if value is None:
        return ["null"]
    if isinstance(value, bytes):
        return ["bytes", value.hex()]
    if isinstance(value, bool):
        return ["bool", value]
    if isinstance(value, int):
        return ["int", value]
    if isinstance(value, float):
        return ["float", repr(value)]
    return ["text", str(value)]


def database_guard(database: Path, source_ids: set[str]) -> str:
    """Fingerprint all logical DB state except authorized source section fields."""
    digest = hashlib.sha256()
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise migration.MigrationError(f"Database failed quick_check: {database}")
        schema = connection.execute(
            """SELECT type, name, tbl_name, COALESCE(sql, '')
                 FROM sqlite_master
                WHERE name NOT LIKE 'sqlite_%'
                ORDER BY type, name"""
        ).fetchall()
        digest.update(json.dumps(schema, separators=(",", ":")).encode("utf-8"))
        table_names = sorted(
            row[0]
            for row in connection.execute(
                """SELECT name FROM sqlite_master
                     WHERE type='table' AND name NOT LIKE 'sqlite_%'"""
            )
        )
        for table in table_names:
            escaped = table.replace('"', '""')
            cursor = connection.execute(f'SELECT * FROM "{escaped}"')
            columns = [item[0] for item in cursor.description]
            encoded_rows: list[str] = []
            id_index = columns.index("id") if "id" in columns else None
            section_indexes = {
                columns.index(field) for field in SECTION_FIELDS if field in columns
            }
            for raw_row in cursor:
                row = list(raw_row)
                if (
                    table == "threads"
                    and id_index is not None
                    and row[id_index] in source_ids
                ):
                    for index in section_indexes:
                        row[index] = None
                encoded_rows.append(
                    json.dumps(
                        [encoded_sqlite_cell(value) for value in row],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )
            encoded_rows.sort()
            digest.update(table.encode("utf-8"))
            digest.update(json.dumps(columns, separators=(",", ":")).encode("utf-8"))
            for row in encoded_rows:
                digest.update(row.encode("utf-8"))
                digest.update(b"\n")
    finally:
        connection.close()
    return digest.hexdigest()


def source_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {source["id"]: source for source in manifest["sources"]}


def child_map(manifest: dict[str, Any]) -> dict[str, str]:
    return {source_id: entry["id"] for source_id, entry in manifest["children"].items()}


def targeted_state(
    state: dict[str, Any], source_ids: set[str], child_ids: set[str]
) -> dict[str, Any]:
    relevant_ids = source_ids | child_ids
    assignments = state.get("thread-project-assignments", {})
    value = {
        "pinned-thread-ids": [
            item for item in state.get("pinned-thread-ids", []) if item in relevant_ids
        ],
        "thread-project-assignments": {
            key: assignment
            for key, assignment in assignments.items()
            if key in relevant_ids
        },
        "sidebar-project-thread-orders": {
            project_id: order
            for project_id, order in state.get("sidebar-project-thread-orders", {}).items()
            if project_id in {migration.CODEX_PROJECT_ID, migration.JAMBO_PROJECT_ID}
        },
        "projectless-thread-ids": [
            item
            for item in state.get("projectless-thread-ids", [])
            if item in relevant_ids
        ],
    }
    return copy.deepcopy(value)


def expected_assignment(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "projectKind": "local",
        "projectId": source["project_id"],
        "cwd": source["cwd"],
        "pendingCoreUpdate": False,
    }


def validate_manifest(manifest: dict[str, Any], codex_home: Path) -> None:
    authorized = {target["id"]: target for target in migration.TARGETS}
    sources = source_map(manifest)
    children = child_map(manifest)
    if (
        len(manifest.get("sources", [])) != len(authorized)
        or len(sources) != len(authorized)
        or len(children) != len(authorized)
        or set(sources) != set(authorized)
        or set(children) != set(authorized)
    ):
        raise migration.MigrationError("Manifest does not contain the authorized 17 tasks")
    if len(set(children.values())) != len(children) or set(children.values()) & set(sources):
        raise migration.MigrationError("Manifest child IDs are not unique")
    if manifest.get("source_provider") != migration.SOURCE_PROVIDER:
        raise migration.MigrationError("Unexpected source provider in manifest")
    if manifest.get("target_provider") != migration.TARGET_PROVIDER:
        raise migration.MigrationError("Unexpected target provider in manifest")
    if manifest.get("state_database") != migration.state_database(codex_home).name:
        raise migration.MigrationError("The active Codex state database changed")
    for source_id, target in authorized.items():
        source = sources[source_id]
        if source.get("project_id") != target["project_id"] or source.get("cwd") != target["cwd"]:
            raise migration.MigrationError(f"Project mapping changed for {source_id}")


def validate_state_shapes(state: dict[str, Any]) -> None:
    expected_types = {
        "local-projects": dict,
        "thread-project-assignments": dict,
        "sidebar-project-thread-orders": dict,
        "pinned-thread-ids": list,
        "projectless-thread-ids": list,
        "electron-persisted-atom-state": dict,
    }
    for key, expected_type in expected_types.items():
        if not isinstance(state.get(key), expected_type):
            raise migration.MigrationError(f"Unexpected global-state shape: {key}")
    preferences = state["electron-persisted-atom-state"].get(
        "flat-project-sidebar-preferences-v1"
    )
    if not isinstance(preferences, dict) or preferences.get("projectSortMode") != "manual":
        raise migration.MigrationError("Project sidebar is no longer in manual order mode")


def order_occurrences(state: dict[str, Any], thread_id: str) -> list[tuple[str, int]]:
    occurrences: list[tuple[str, int]] = []
    for project_id, order in state["sidebar-project-thread-orders"].items():
        if not isinstance(order, dict) or not isinstance(order.get("threadIds"), list):
            raise migration.MigrationError(f"Malformed project order: {project_id}")
        occurrences.extend(
            (project_id, index)
            for index, item in enumerate(order["threadIds"])
            if item == thread_id
        )
    return occurrences


def classify_global_state(state: dict[str, Any], manifest: dict[str, Any]) -> str:
    validate_state_shapes(state)
    sources = source_map(manifest)
    children = child_map(manifest)
    projects = state["local-projects"]
    assignments = state["thread-project-assignments"]
    pins = state["pinned-thread-ids"]
    projectless = state["projectless-thread-ids"]
    before_flags: list[bool] = []
    applied_flags: list[bool] = []

    if len(pins) != len(set(pins)):
        raise migration.MigrationError("Duplicate IDs in the legacy pin list")
    for source_id, source in sources.items():
        child_id = children[source_id]
        project = projects.get(source["project_id"])
        if not isinstance(project, dict) or source["cwd"] not in project.get("rootPaths", []):
            raise migration.MigrationError(f"Saved project changed: {source['project_id']}")
        source_slots = order_occurrences(state, source_id)
        child_slots = order_occurrences(state, child_id)
        if len(source_slots) != 1 or source_slots[0][0] != source["project_id"]:
            raise migration.MigrationError(f"Source is not in its exact project order: {source_id}")
        source_slot = source_slots[0]
        child_is_applied = (
            len(child_slots) == 1
            and child_slots[0] == (source["project_id"], source_slot[1] + 1)
        )
        child_is_before = len(child_slots) == 0
        if not child_is_before and not child_is_applied:
            raise migration.MigrationError(f"Child has an unexpected project slot: {child_id}")
        assignment = assignments.get(child_id)
        assignment_is_before = assignment is None
        assignment_is_applied = assignment == expected_assignment(source)
        if not assignment_is_before and not assignment_is_applied:
            raise migration.MigrationError(f"Child has a conflicting project assignment: {child_id}")
        source_assignment = assignments.get(source_id)
        if source_assignment not in (None, expected_assignment(source)):
            raise migration.MigrationError(
                f"Source has a conflicting project assignment: {source_id}"
            )
        if child_id in projectless or source_id in projectless:
            raise migration.MigrationError(f"Target task is marked projectless: {source_id}")
        before_flags.append(
            child_is_before
            and assignment_is_before
            and source_id in pins
            and child_id not in pins
        )
        applied_flags.append(
            child_is_applied
            and assignment_is_applied
            and source_assignment == expected_assignment(source)
            and source_id not in pins
            and child_id not in pins
        )
    if all(before_flags):
        return "before"
    if all(applied_flags):
        return "applied"
    raise migration.MigrationError("Global state is a mixed or partial cutover")


def transform_global_state(
    state: dict[str, Any], manifest: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    classify_global_state(state, manifest)
    transformed = copy.deepcopy(state)
    sources = source_map(manifest)
    children = child_map(manifest)
    source_ids = set(sources)
    child_ids = set(children.values())
    before = targeted_state(state, source_ids, child_ids)

    assignments = transformed["thread-project-assignments"]
    for source_id, source in sources.items():
        assignments[source_id] = expected_assignment(source)
        assignments[children[source_id]] = expected_assignment(source)

    for project_id in {migration.CODEX_PROJECT_ID, migration.JAMBO_PROJECT_ID}:
        order = transformed["sidebar-project-thread-orders"][project_id]
        project_sources = {
            source_id: children[source_id]
            for source_id, source in sources.items()
            if source["project_id"] == project_id
        }
        without_children = [
            thread_id for thread_id in order["threadIds"] if thread_id not in child_ids
        ]
        new_order: list[str] = []
        for thread_id in without_children:
            new_order.append(thread_id)
            child_id = project_sources.get(thread_id)
            if child_id is not None:
                new_order.append(child_id)
        if len(new_order) != len(set(new_order)):
            raise migration.MigrationError(f"Duplicate task in project order {project_id}")
        order["threadIds"] = new_order

    relevant_ids = source_ids | child_ids
    transformed["pinned-thread-ids"] = [
        thread_id
        for thread_id in transformed["pinned-thread-ids"]
        if thread_id not in relevant_ids
    ]
    transformed["projectless-thread-ids"] = [
        thread_id
        for thread_id in transformed["projectless-thread-ids"]
        if thread_id not in relevant_ids
    ]
    if classify_global_state(transformed, manifest) != "applied":
        raise migration.MigrationError("Generated global state failed validation")
    return transformed, before


def next_backup_directory(migration_backup: Path) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = migration_backup / f"cutover-backup-{stamp}"
    suffix = 1
    while candidate.exists():
        candidate = migration_backup / f"cutover-backup-{stamp}-{suffix}"
        suffix += 1
    candidate.mkdir(mode=0o700)
    os.chmod(candidate, 0o700)
    migration.fsync_directory(candidate.parent)
    return candidate


def copy_and_verify(source: Path, destination: Path) -> str:
    digest = migration.sha256(source)
    migration.copy_private(source, destination)
    if migration.sha256(destination) != digest:
        raise migration.MigrationError(f"Backup copy failed verification: {source}")
    return digest


def create_cutover_backup(
    migration_backup: Path,
    codex_home: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    current_state: dict[str, Any],
    transformed_state: dict[str, Any],
) -> tuple[Path, Path, dict[str, Any]]:
    backup = next_backup_directory(migration_backup)
    database = migration.state_database(codex_home)
    database_copy = backup / database.name
    migration.sqlite_snapshot(database, database_copy)
    artifacts: dict[str, str] = {database.name: migration.sha256(database_copy)}
    files = [
        (codex_home / ".codex-global-state.json", "codex-global-state.json"),
        (codex_home / ".codex-global-state.json.bak", "codex-global-state.json.bak"),
        (codex_home / "session_index.jsonl", "session_index.jsonl"),
        (manifest_path, "migration-manifest.json"),
    ]
    for source, name in files:
        if not source.is_file():
            raise migration.MigrationError(f"Required cutover artifact is missing: {source}")
        artifacts[name] = copy_and_verify(source, backup / name)
    source_ids = set(source_map(manifest))
    child_ids = set(child_map(manifest).values())
    logical_database_guard = database_guard(database, source_ids)
    if database_guard(database_copy, source_ids) != logical_database_guard:
        raise migration.MigrationError("Cutover database snapshot is not logically identical")
    before_path = backup / "cutover-before.json"
    migration.write_json_atomic(
        before_path,
        {
            "created_at": migration.now_iso(),
            "targeted_state": targeted_state(current_state, source_ids, child_ids),
        },
    )
    artifacts[before_path.name] = migration.sha256(before_path)
    after_path = backup / "global-state-after.json"
    migration.write_json_atomic(after_path, transformed_state)
    artifacts[after_path.name] = migration.sha256(after_path)
    journal = {
        "format": 1,
        "created_at": migration.now_iso(),
        "phase": "prepared",
        "manifest_path": str(manifest_path),
        "codex_home": str(codex_home),
        "state_database": database.name,
        "artifacts": artifacts,
        "database_guard": logical_database_guard,
        "source_ids": sorted(source_ids),
        "child_ids": sorted(child_ids),
    }
    journal_path = backup / JOURNAL_NAME
    migration.write_json_atomic(journal_path, journal)
    return backup, journal_path, journal


def update_journal(
    journal_path: Path, journal: dict[str, Any], phase: str, **extra: Any
) -> None:
    journal["phase"] = phase
    journal["updated_at"] = migration.now_iso()
    journal.update(extra)
    migration.write_json_atomic(journal_path, journal)


def verify_global_prestate(
    codex_home: Path,
    expected_state: dict[str, Any],
    journal: dict[str, Any],
) -> None:
    paths = {
        "codex-global-state.json": codex_home / ".codex-global-state.json",
        "codex-global-state.json.bak": codex_home / ".codex-global-state.json.bak",
    }
    for artifact_name, path in paths.items():
        if json.loads(path.read_text(encoding="utf-8")) != expected_state:
            raise migration.MigrationError(
                "Global sidebar state changed before the authorized replacement"
            )
        if migration.sha256(path) != journal["artifacts"][artifact_name]:
            raise migration.MigrationError(
                "Global sidebar file bytes changed before the authorized replacement"
            )


def atomic_restore_file(source: Path, destination: Path) -> None:
    temporary = destination.with_name(f".{destination.name}.restore-{os.getpid()}")
    migration.copy_private(source, temporary)
    os.replace(temporary, destination)
    migration.fsync_directory(destination.parent)


def validate_sqlite_file(database: Path) -> None:
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise migration.MigrationError(f"SQLite validation failed: {database}")
    finally:
        connection.close()


def restore_database(snapshot: Path, destination: Path, recovery_directory: Path) -> None:
    validate_sqlite_file(snapshot)
    evidence = recovery_directory / "pre-rollback-current.sqlite"
    suffix = 1
    while evidence.exists():
        evidence = recovery_directory / f"pre-rollback-current-{suffix}.sqlite"
        suffix += 1
    migration.sqlite_snapshot(destination, evidence)
    temporary = destination.with_name(f".{destination.name}.restore-{os.getpid()}")
    migration.copy_private(snapshot, temporary)
    validate_sqlite_file(temporary)

    connection = sqlite3.connect(destination)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    finally:
        connection.close()
    for suffix_name in ("-wal", "-shm"):
        sidecar = Path(f"{destination}{suffix_name}")
        if sidecar.exists():
            saved = recovery_directory / f"pre-rollback-{destination.name}{suffix_name}"
            os.replace(sidecar, saved)
    os.replace(temporary, destination)
    migration.fsync_directory(destination.parent)
    validate_sqlite_file(destination)


def validate_journal(
    backup: Path,
    journal: dict[str, Any],
    manifest_path: Path,
    manifest: dict[str, Any],
    codex_home: Path,
) -> None:
    sources = set(source_map(manifest))
    children = set(child_map(manifest).values())
    if backup.parent != manifest_path.parent:
        raise migration.MigrationError("Cutover journal is outside its migration backup")
    if Path(journal.get("manifest_path", "")).resolve() != manifest_path:
        raise migration.MigrationError("Cutover journal belongs to a different manifest")
    if Path(journal.get("codex_home", "")).resolve() != codex_home:
        raise migration.MigrationError("Cutover journal belongs to a different CODEX_HOME")
    if journal.get("state_database") != migration.state_database(codex_home).name:
        raise migration.MigrationError("Cutover journal names a different state database")
    if set(journal.get("source_ids", [])) != sources:
        raise migration.MigrationError("Cutover journal source set is not authorized")
    if set(journal.get("child_ids", [])) != children:
        raise migration.MigrationError("Cutover journal child set is not authorized")
    required = {
        journal["state_database"],
        "codex-global-state.json",
        "codex-global-state.json.bak",
        "migration-manifest.json",
        "global-state-after.json",
        "cutover-before.json",
    }
    artifacts = journal.get("artifacts")
    if not isinstance(artifacts, dict) or not required.issubset(artifacts):
        raise migration.MigrationError("Cutover journal artifact manifest is incomplete")
    for name, expected_hash in artifacts.items():
        candidate = backup / name
        if (
            not candidate.is_file()
            or not isinstance(expected_hash, str)
            or migration.sha256(candidate) != expected_hash
        ):
            raise migration.MigrationError(f"Cutover backup artifact is invalid: {name}")
    snapshot = backup / journal["state_database"]
    validate_sqlite_file(snapshot)
    if database_guard(snapshot, sources) != journal.get("database_guard"):
        raise migration.MigrationError("Cutover database snapshot fingerprint changed")


def verify_recovery_is_target_only(
    backup: Path,
    journal: dict[str, Any],
    codex_home: Path,
    manifest: dict[str, Any],
) -> None:
    sources = set(source_map(manifest))
    database = migration.state_database(codex_home)
    if database_guard(database, sources) != journal["database_guard"]:
        raise migration.MigrationError(
            "Unrelated Codex database state changed after the interrupted cutover; "
            "automatic full-store rollback was refused"
        )
    allowed_global_hashes = {
        journal["artifacts"]["codex-global-state.json"],
        journal["artifacts"]["codex-global-state.json.bak"],
        journal["artifacts"]["global-state-after.json"],
    }
    for live in (
        codex_home / ".codex-global-state.json",
        codex_home / ".codex-global-state.json.bak",
    ):
        if not live.is_file() or migration.sha256(live) not in allowed_global_hashes:
            raise migration.MigrationError(
                "Unrelated global sidebar state changed after the interrupted cutover; "
                "automatic full-file rollback was refused"
            )


def rollback_cutover(
    backup: Path,
    journal_path: Path,
    journal: dict[str, Any],
    codex_home: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    phase: str,
) -> None:
    assert_offline(codex_home)
    validate_journal(backup, journal, manifest_path, manifest, codex_home)
    verify_recovery_is_target_only(backup, journal, codex_home, manifest)
    update_journal(journal_path, journal, "rollback_started")
    database = migration.state_database(codex_home)
    if database.name != journal["state_database"]:
        raise migration.MigrationError("Cannot roll back a different state database")
    restore_database(backup / database.name, database, backup)
    atomic_restore_file(
        backup / "codex-global-state.json", codex_home / ".codex-global-state.json"
    )
    atomic_restore_file(
        backup / "codex-global-state.json.bak",
        codex_home / ".codex-global-state.json.bak",
    )
    atomic_restore_file(backup / "migration-manifest.json", manifest_path)
    for name, live in {
        "codex-global-state.json": codex_home / ".codex-global-state.json",
        "codex-global-state.json.bak": codex_home / ".codex-global-state.json.bak",
        "migration-manifest.json": manifest_path,
    }.items():
        if migration.sha256(live) != journal["artifacts"][name]:
            raise migration.MigrationError(f"Rollback verification failed: {live}")
    if database_guard(database, set(source_map(manifest))) != journal["database_guard"]:
        raise migration.MigrationError("Rollback database fingerprint does not match")
    verify_core_before(codex_home, manifest)
    for source_id, source in source_map(manifest).items():
        migration.verify_source_unchanged(source, codex_home)
        migration.verify_child(
            source, {"id": child_map(manifest)[source_id]}, codex_home
        )
    update_journal(journal_path, journal, phase)


def recover_incomplete_cutover(
    migration_backup: Path,
    codex_home: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
) -> None:
    incomplete: list[tuple[Path, dict[str, Any]]] = []
    for journal_path in sorted(migration_backup.glob(f"cutover-backup-*/{JOURNAL_NAME}")):
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        if journal.get("phase") not in TERMINAL_JOURNAL_PHASES:
            incomplete.append((journal_path, journal))
    if len(incomplete) > 1:
        raise migration.MigrationError("Multiple incomplete cutover journals require review")
    if not incomplete:
        return
    journal_path, journal = incomplete[0]
    validate_journal(journal_path.parent, journal, manifest_path, manifest, codex_home)
    if journal.get("phase") == "prepared":
        update_journal(journal_path, journal, "abandoned_prepared")
        return
    rollback_cutover(
        journal_path.parent,
        journal_path,
        journal,
        codex_home,
        manifest_path,
        manifest,
        "rollback_recovered",
    )


def latest_applied_report(migration_backup: Path) -> dict[str, Any] | None:
    for journal_path in sorted(
        migration_backup.glob(f"cutover-backup-*/{JOURNAL_NAME}"), reverse=True
    ):
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        if journal.get("phase") != APPLIED_STATUS:
            continue
        report_path = journal.get("report")
        if not isinstance(report_path, str):
            return None
        candidate = Path(report_path)
        if not candidate.is_file() or candidate.parent != journal_path.parent:
            raise migration.MigrationError("Applied cutover report is missing or misplaced")
        return json.loads(candidate.read_text(encoding="utf-8"))
    return None


def unpin_core_sources(codex: Path, codex_home: Path, source_ids: list[str]) -> None:
    server = migration.AppServer(codex, codex_home)
    try:
        server.initialize()
        for source_id in source_ids:
            server.request(
                "thread/section/move",
                {"threadId": source_id, "sectionId": None, "beforeThreadId": None},
            )
    finally:
        server.close()


def thread_section_rows(
    codex_home: Path, thread_ids: set[str]
) -> dict[str, dict[str, Any]]:
    connection = sqlite3.connect(
        f"file:{migration.state_database(codex_home)}?mode=ro", uri=True
    )
    connection.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" for _ in thread_ids)
        rows = connection.execute(
            f"""SELECT id, thread_section_id, section_position,
                       section_entered_at_ms, is_pinned
                  FROM threads WHERE id IN ({placeholders})""",
            tuple(sorted(thread_ids)),
        ).fetchall()
    finally:
        connection.close()
    return {row["id"]: dict(row) for row in rows}


def verify_core_before(codex_home: Path, manifest: dict[str, Any]) -> None:
    sources = source_map(manifest)
    children = child_map(manifest)
    rows = thread_section_rows(codex_home, set(sources) | set(children.values()))
    if len(rows) != len(sources) + len(children):
        raise migration.MigrationError("A source or child row is missing")
    for source_id, source in sources.items():
        row = rows[source_id]
        for field in SECTION_FIELDS | {"is_pinned"}:
            if row[field] != source[field]:
                raise migration.MigrationError(f"Source core placement changed: {source_id}")
        child = rows[children[source_id]]
        if child["thread_section_id"] is not None or child["is_pinned"] != 0:
            raise migration.MigrationError(f"Child is unexpectedly pinned: {children[source_id]}")


def verify_source_after_cutover(source: dict[str, Any], codex_home: Path) -> None:
    database = migration.state_database(codex_home)
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute(
            """SELECT rollout_path, source, model_provider, cwd, archived,
                      title, preview, name, history_mode, model,
                      thread_section_id, section_position, section_entered_at_ms,
                      is_pinned
                 FROM threads WHERE id = ?""",
            (source["id"],),
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        raise migration.MigrationError(f"Source row disappeared: {source['id']}")
    current = dict(row)
    for key in migration.SOURCE_ROW_KEYS - SECTION_FIELDS:
        if current.get(key) != source.get(key):
            raise migration.MigrationError(f"Source changed during cutover: {source['id']} {key}")
    if any(current[field] is not None for field in SECTION_FIELDS):
        raise migration.MigrationError(f"Source remains in a core section: {source['id']}")
    rollout = Path(current["rollout_path"])
    if (
        not rollout.is_file()
        or rollout.stat().st_size != source["rollout_bytes"]
        or migration.sha256(rollout) != source["rollout_sha256"]
    ):
        raise migration.MigrationError(f"Source rollout changed: {source['id']}")


def verify_applied_cutover(
    codex_home: Path,
    manifest: dict[str, Any],
    expected_state: dict[str, Any] | None = None,
    expected_targeted: dict[str, Any] | None = None,
) -> dict[str, Any]:
    global_path = codex_home / ".codex-global-state.json"
    backup_path = codex_home / ".codex-global-state.json.bak"
    state = json.loads(global_path.read_text(encoding="utf-8"))
    backup_state = json.loads(backup_path.read_text(encoding="utf-8"))
    if state != backup_state:
        raise migration.MigrationError("Global-state primary and backup do not match")
    if expected_state is not None and state != expected_state:
        raise migration.MigrationError("Persisted global state differs from the authorized transform")
    if classify_global_state(state, manifest) != "applied":
        raise migration.MigrationError("Project cutover was not fully applied")

    sources = source_map(manifest)
    children = child_map(manifest)
    if expected_targeted is None and expected_state is not None:
        expected_targeted = targeted_state(
            expected_state, set(sources), set(children.values())
        )
    if expected_targeted is None:
        cutover = manifest.get("cutover")
        expected_targeted = cutover.get("after") if isinstance(cutover, dict) else None
    if not isinstance(expected_targeted, dict):
        raise migration.MigrationError("Exact post-cutover project order is unavailable")
    if targeted_state(state, set(sources), set(children.values())) != expected_targeted:
        raise migration.MigrationError("Exact project assignment/order changed after cutover")
    rows = thread_section_rows(codex_home, set(sources) | set(children.values()))
    for source_id, source in sources.items():
        verify_source_after_cutover(source, codex_home)
        migration.verify_child(source, {"id": children[source_id]}, codex_home)
        child_row = rows[children[source_id]]
        if child_row["thread_section_id"] is not None or child_row["is_pinned"] != 0:
            raise migration.MigrationError(f"Child is unexpectedly pinned: {children[source_id]}")
    connection = sqlite3.connect(
        f"file:{migration.state_database(codex_home)}?mode=ro", uri=True
    )
    try:
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise migration.MigrationError("State database failed quick_check")
    finally:
        connection.close()
    return {
        "source_count": len(sources),
        "child_count": len(children),
        "codex_project_children": sum(
            source["project_id"] == migration.CODEX_PROJECT_ID
            for source in sources.values()
        ),
        "jambo_project_children": sum(
            source["project_id"] == migration.JAMBO_PROJECT_ID
            for source in sources.values()
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--codex",
        type=Path,
        default=Path("/Applications/ChatGPT.app/Contents/Resources/codex"),
    )
    parser.add_argument("--wait-for-app-exit", action="store_true")
    parser.add_argument("--wait-timeout", type=int, default=3600)
    parser.add_argument("--relaunch", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest.expanduser().resolve()
    migration_backup = manifest_path.parent
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    codex_home = Path(manifest["codex_home"]).resolve()
    cc_switch_home = Path(manifest["cc_switch_home"]).resolve()
    codex = args.codex.expanduser().resolve()
    if not codex.is_file():
        raise migration.MigrationError(f"Codex binary not found: {codex}")

    if args.wait_for_app_exit:
        wait_until_offline(codex_home, args.wait_timeout)
    else:
        assert_offline(codex_home)

    result: dict[str, Any]
    cutover_backup: Path | None = None
    with migration.migration_lock(codex_home):
        assert_offline(codex_home)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_manifest(manifest, codex_home)
        recover_incomplete_cutover(
            migration_backup, codex_home, manifest_path, manifest
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_manifest(manifest, codex_home)
        migration.verify_route_unchanged(manifest, codex_home, cc_switch_home)

        live_state = json.loads(
            (codex_home / ".codex-global-state.json").read_text(encoding="utf-8")
        )
        live_phase = classify_global_state(live_state, manifest)

        if manifest.get("status") in {APPLIED_STATUS, FINAL_STATUS} or live_phase == "applied":
            report = (
                latest_applied_report(migration_backup)
                if manifest.get("status") == "forks_verified"
                else manifest.get("cutover")
            )
            if not isinstance(report, dict) or not isinstance(report.get("after"), dict):
                raise migration.MigrationError("Applied state has no exact cutover report")
            result = verify_applied_cutover(
                codex_home, manifest, expected_targeted=report["after"]
            )
            if manifest.get("status") == "forks_verified":
                manifest["cutover"] = report
                manifest["status"] = APPLIED_STATUS
                migration.write_json_atomic(manifest_path, manifest)
            print(f"status {manifest['status']}", flush=True)
        else:
            if manifest.get("status") != "forks_verified":
                raise migration.MigrationError("Fork migration is not fully verified")
            sources = source_map(manifest)
            children = child_map(manifest)
            source_ids = set(sources)
            child_ids = set(children.values())
            migration.verify_source_ui_state(migration_backup, codex_home, source_ids)
            for source_id, source in sources.items():
                migration.verify_source_unchanged(source, codex_home)
                migration.verify_child(source, {"id": children[source_id]}, codex_home)
            verify_core_before(codex_home, manifest)

            global_path = codex_home / ".codex-global-state.json"
            global_backup_path = codex_home / ".codex-global-state.json.bak"
            current_state = json.loads(global_path.read_text(encoding="utf-8"))
            current_backup_state = json.loads(
                global_backup_path.read_text(encoding="utf-8")
            )
            if current_state != current_backup_state:
                raise migration.MigrationError("Global-state primary and backup differ")
            if classify_global_state(current_state, manifest) != "before":
                raise migration.MigrationError("Cutover pre-state is not exact")
            transformed, before = transform_global_state(current_state, manifest)

            cutover_backup, journal_path, journal = create_cutover_backup(
                migration_backup,
                codex_home,
                manifest_path,
                manifest,
                current_state,
                transformed,
            )
            try:
                assert_offline(codex_home)
                verify_global_prestate(codex_home, current_state, journal)
                migration.verify_route_unchanged(manifest, codex_home, cc_switch_home)
                for source_id, source in sources.items():
                    migration.verify_source_unchanged(source, codex_home)
                    migration.verify_child(
                        source, {"id": children[source_id]}, codex_home
                    )
                update_journal(journal_path, journal, "core_unpin_started")
                unpin_core_sources(codex, codex_home, list(sources))
                update_journal(journal_path, journal, "core_unpinned")

                assert_offline(codex_home)
                verify_global_prestate(codex_home, current_state, journal)
                if database_guard(
                    migration.state_database(codex_home), source_ids
                ) != journal["database_guard"]:
                    raise migration.MigrationError(
                        "App-server changed unrelated database state during core unpin"
                    )
                for source in sources.values():
                    verify_source_after_cutover(source, codex_home)
                migration.write_json_atomic(global_path, transformed)
                update_journal(journal_path, journal, "global_primary_written")
                migration.write_json_atomic(global_backup_path, transformed)
                update_journal(journal_path, journal, "global_backup_written")

                result = verify_applied_cutover(codex_home, manifest, transformed)
                migration.verify_route_unchanged(manifest, codex_home, cc_switch_home)
                report = {
                    "completed_at": migration.now_iso(),
                    "status": APPLIED_STATUS,
                    "backup": str(cutover_backup),
                    "before": before,
                    "after": targeted_state(transformed, source_ids, child_ids),
                    "result": result,
                }
                migration.write_json_atomic(
                    cutover_backup / "cutover-report.json", report
                )
                update_journal(
                    journal_path,
                    journal,
                    APPLIED_STATUS,
                    report=str(cutover_backup / "cutover-report.json"),
                )
                manifest["cutover"] = report
                manifest["status"] = APPLIED_STATUS
                migration.write_json_atomic(manifest_path, manifest)
            except Exception as exc:
                try:
                    rollback_cutover(
                        cutover_backup,
                        journal_path,
                        journal,
                        codex_home,
                        manifest_path,
                        manifest,
                        "rolled_back",
                    )
                except Exception as rollback_exc:
                    update_journal(
                        journal_path,
                        journal,
                        "rollback_required",
                        original_error=str(exc),
                        rollback_error=str(rollback_exc),
                    )
                    raise migration.MigrationError(
                        f"Cutover failed and needs recovery from {cutover_backup}: {rollback_exc}"
                    ) from exc
                raise

    print(f"backup {cutover_backup or manifest.get('cutover', {}).get('backup', '')}", flush=True)
    print(f"children {result['child_count']}", flush=True)
    if args.relaunch:
        subprocess.Popen(
            ["/usr/bin/open", "-a", "ChatGPT"], start_new_session=True
        )
        print("relaunch requested", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        migration.MigrationError,
        OSError,
        sqlite3.Error,
        json.JSONDecodeError,
        subprocess.SubprocessError,
    ) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
