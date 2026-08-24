#!/usr/bin/env python3
"""Create reversible current-provider copies of selected Codex project tasks.

This script never edits the source rollouts or CCSwitch configuration. It takes a
private backup, forks each source through the supported app-server protocol, and
verifies that the model-visible history survived the fork.
"""

from __future__ import annotations

import argparse
import collections
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import sqlite3
import subprocess
import sys
import time
from typing import Any


SOURCE_PROVIDER = "openai"
TARGET_PROVIDER = "cc-switch-official"
SEMANTIC_VERSION = 2
CODEX_PROJECT_ID = "local-259cae12db4be047d922651939e1233f"
JAMBO_PROJECT_ID = "0e833886-0156-4cad-a043-600ad8443a7f"
CODEX_CWD = "/Users/devsantorz/Desktop/devProjects/codex_christi"
JAMBO_CWD = "/Users/devsantorz/Desktop/devProjects/jambo-finance"

TARGETS = [
    {"id": "019fef5c-c4f9-7652-882a-40695da1c405", "project_id": JAMBO_PROJECT_ID, "cwd": JAMBO_CWD},
    {"id": "019fa5b1-4780-78d3-8505-b640d6b0175a", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019fd7d0-9ed5-7f60-8f32-24d4ae36e152", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019ee269-5a10-7050-99fd-ed5524ae7e01", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019f8d3a-e228-73e2-892b-56106d414ba7", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019ee2cc-cc1c-74b1-8c76-2cab073364d6", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019dd142-3a5e-7211-8e5f-ae9dc02d3272", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019ee8f6-4c1c-72d2-986a-3cf8f52b1be9", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019ee96c-eb65-7043-9219-d8c06ce0fd08", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019f005b-5dd6-7363-ad52-5424eb345e23", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019edc88-5e34-79b0-a2ae-a7d30e0961e3", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019edece-998e-7a62-8f92-c1225c5de5b4", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019e8c44-db71-7111-925c-00ed95d422a5", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019d452a-78fd-7900-b3e0-1f12f35de260", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019d8380-7a93-77d3-a1b2-57bc6ec76db4", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019d7657-45ac-7d42-923e-a725e350cad6", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
    {"id": "019d755d-2f0e-7461-8723-fd48808519dd", "project_id": CODEX_PROJECT_ID, "cwd": CODEX_CWD},
]

SEMANTIC_EVENT_TYPES = {
    "agent_message",
    "agent_reasoning",
    "task_complete",
    "task_started",
    "user_message",
}


class MigrationError(RuntimeError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json_atomic(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def sqlite_snapshot(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    destination_connection = sqlite3.connect(destination)
    try:
        source_connection.backup(destination_connection)
        destination_connection.commit()
        result = destination_connection.execute("PRAGMA quick_check").fetchone()
        if result != ("ok",):
            raise MigrationError(f"SQLite snapshot failed validation: {destination}")
    finally:
        destination_connection.close()
        source_connection.close()
    os.chmod(destination, 0o600)


def validate_jsonl(path: Path) -> int:
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for count, line in enumerate(handle, 1):
            try:
                json.loads(line)
            except json.JSONDecodeError as exc:
                raise MigrationError(f"Malformed JSONL in {path} at line {count}") from exc
    if count == 0:
        raise MigrationError(f"Empty rollout: {path}")
    return count


def normalize_semantic(value: Any) -> Any:
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if key == "timestamp" or key in {
                "call_id",
                "id",
                "item_id",
                "session_id",
                "thread_id",
                "turn_id",
            }:
                continue
            normalized_key = "window_number" if key == "window_id" else key
            item = normalize_semantic(item)
            if item in (None, [], {}):
                continue
            normalized[normalized_key] = item
        return normalized
    if isinstance(value, list):
        return [normalize_semantic(item) for item in value]
    return value


def semantic_history(path: Path, prefix_records: int | None = None) -> tuple[int, str]:
    digest = hashlib.sha256()
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            keep = record.get("type") in {"compacted", "response_item"}
            if record.get("type") == "event_msg":
                keep = record.get("payload", {}).get("type") in (
                    SEMANTIC_EVENT_TYPES | {"context_compacted"}
                )
            if not keep:
                continue
            count += 1
            if prefix_records is None or count <= prefix_records:
                canonical = json.dumps(
                    normalize_semantic(record),
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
                digest.update(canonical)
                digest.update(b"\n")
    return count, digest.hexdigest()


def first_session_meta(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            if record.get("type") == "session_meta":
                payload = record.get("payload")
                return payload if isinstance(payload, dict) else {}
    raise MigrationError(f"No session_meta in {path}")


def load_thread_names(codex_home: Path) -> dict[str, str]:
    names: dict[str, str] = {}
    index = codex_home / "session_index.jsonl"
    if not index.is_file():
        return names
    with index.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            thread_id = row.get("id")
            name = row.get("thread_name")
            if isinstance(thread_id, str) and isinstance(name, str) and name.strip():
                names[thread_id] = name.strip()
    return names


def validate_saved_projects(codex_home: Path) -> None:
    global_state_path = codex_home / ".codex-global-state.json"
    state = json.loads(global_state_path.read_text(encoding="utf-8"))
    projects = state.get("local-projects", {})
    expected = {
        CODEX_PROJECT_ID: CODEX_CWD,
        JAMBO_PROJECT_ID: JAMBO_CWD,
    }
    for project_id, root in expected.items():
        project = projects.get(project_id)
        if not isinstance(project, dict) or root not in project.get("rootPaths", []):
            raise MigrationError(f"Saved project mapping changed: {project_id}")


def strip_toml_comment(value: str) -> str:
    quote: str | None = None
    escaped = False
    for index, character in enumerate(value):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {'"', "'"}:
            quote = None if quote == character else (character if quote is None else quote)
            continue
        if character == "#" and quote is None:
            return value[:index].rstrip()
    return value.strip()


def toml_scalar(value: str) -> Any:
    value = strip_toml_comment(value.strip())
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1]
    if value in {"true", "false"}:
        return value == "true"
    return value


def codex_route_config(config_path: Path) -> dict[str, Any]:
    active_provider: str | None = None
    current_table: str | None = None
    providers: dict[str, dict[str, Any]] = {}
    for raw_line in config_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_table = line[1:-1].strip()
            continue
        if "=" not in line:
            continue
        key, raw_value = (part.strip() for part in line.split("=", 1))
        value = toml_scalar(raw_value)
        if current_table is None and key == "model_provider" and isinstance(value, str):
            active_provider = value
        elif current_table and current_table.startswith("model_providers."):
            provider_id = current_table.removeprefix("model_providers.")
            provider_id = str(toml_scalar(provider_id))
            providers.setdefault(provider_id, {})[key] = value
    if active_provider is None:
        raise MigrationError(f"No top-level model_provider in {config_path}")
    provider = providers.get(active_provider)
    if not isinstance(provider, dict):
        raise MigrationError(f"No config block for active provider {active_provider}")
    return {"model_provider": active_provider, "provider": provider}


def ccswitch_route_settings(settings_path: Path) -> dict[str, Any]:
    if not settings_path.is_file():
        return {}
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    keys = {
        "currentProviderCodex",
        "enableFailoverToggle",
        "enableLocalProxy",
        "preserveCodexOfficialAuthOnSwitch",
        "unifyCodexSessionHistory",
    }
    return {key: settings.get(key) for key in sorted(keys)}


def route_state(codex_home: Path, cc_switch_home: Path) -> dict[str, Any]:
    state: dict[str, Any] = {
        "route_guard_version": 2,
        "codex_route_config": codex_route_config(codex_home / "config.toml"),
        "ccswitch_route_settings": ccswitch_route_settings(
            cc_switch_home / "settings.json"
        ),
    }
    database = cc_switch_home / "cc-switch.db"
    if database.is_file():
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            state["providers"] = []
            for row in connection.execute(
                """SELECT id, app_type, name, category, is_current,
                          in_failover_queue, sort_index, provider_type,
                          settings_config, meta
                   FROM providers WHERE app_type = 'codex'
                   ORDER BY sort_index, id"""
            ):
                provider = dict(row)
                provider["settings_config_sha256"] = hashlib.sha256(
                    provider.pop("settings_config").encode("utf-8")
                ).hexdigest()
                provider["meta_sha256"] = hashlib.sha256(
                    provider.pop("meta").encode("utf-8")
                ).hexdigest()
                state["providers"].append(provider)
            state["endpoint_hashes"] = [
                {
                    "provider_id": row["provider_id"],
                    "url_sha256": hashlib.sha256(row["url"].encode("utf-8")).hexdigest(),
                }
                for row in connection.execute(
                    """SELECT provider_id, url FROM provider_endpoints
                       WHERE app_type = 'codex' ORDER BY provider_id, id"""
                )
            ]
            state["proxy"] = []
            for row in connection.execute(
                "SELECT * FROM proxy_config WHERE app_type = 'codex'"
            ):
                proxy = dict(row)
                proxy.pop("created_at", None)
                proxy.pop("updated_at", None)
                state["proxy"].append(proxy)
        finally:
            connection.close()
    return state


def state_database(codex_home: Path) -> Path:
    candidates: list[tuple[int, Path]] = []
    for path in codex_home.glob("state_*.sqlite"):
        try:
            version = int(path.stem.removeprefix("state_"))
        except ValueError:
            continue
        candidates.append((version, path))
    if not candidates:
        raise MigrationError(f"No state database under {codex_home}")
    return max(candidates, key=lambda item: item[0])[1]


def source_inventory(codex_home: Path) -> list[dict[str, Any]]:
    validate_saved_projects(codex_home)
    database = state_database(codex_home)
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    names = load_thread_names(codex_home)
    rows: list[dict[str, Any]] = []
    try:
        quick = connection.execute("PRAGMA quick_check").fetchone()
        if quick is None or quick[0] != "ok":
            raise MigrationError("Live state database failed quick_check")
        for target in TARGETS:
            row = connection.execute(
                """SELECT id, rollout_path, source, model_provider, cwd, archived,
                          title, preview, name, history_mode, model,
                          thread_section_id, section_position, section_entered_at_ms,
                          is_pinned
                   FROM threads WHERE id = ?""",
                (target["id"],),
            ).fetchone()
            if row is None:
                raise MigrationError(f"Missing source row {target['id']}")
            data = dict(row)
            if data["model_provider"] != SOURCE_PROVIDER:
                raise MigrationError(f"Unexpected provider for {target['id']}")
            if data["cwd"] != target["cwd"] or data["archived"] != 0:
                raise MigrationError(f"Unexpected cwd/archive state for {target['id']}")
            rollout = Path(data["rollout_path"])
            if not rollout.is_file():
                raise MigrationError(f"Missing rollout for {target['id']}: {rollout}")
            line_count = validate_jsonl(rollout)
            semantic_count, semantic_sha = semantic_history(rollout)
            meta = first_session_meta(rollout)
            if meta.get("id", meta.get("session_id")) != target["id"]:
                raise MigrationError(f"Rollout id mismatch for {target['id']}")
            data.update(
                {
                    "project_id": target["project_id"],
                    "display_name": data.get("name") or names.get(target["id"]),
                    "rollout_bytes": rollout.stat().st_size,
                    "rollout_lines": line_count,
                    "rollout_sha256": sha256(rollout),
                    "semantic_records": semantic_count,
                    "semantic_sha256": semantic_sha,
                }
            )
            rows.append(data)
    finally:
        connection.close()
    return rows


def copy_private(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    os.chmod(destination, 0o600)
    with destination.open("rb") as handle:
        os.fsync(handle.fileno())
    fsync_directory(destination.parent)


def inventory_signature(sources: list[dict[str, Any]]) -> str:
    return hashlib.sha256(
        json.dumps(sources, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def create_backup(
    codex_home: Path,
    cc_switch_home: Path,
    backup_root: Path,
) -> tuple[Path, dict[str, Any]]:
    routes_before = route_state(codex_home, cc_switch_home)
    sources = source_inventory(codex_home)
    source_signature = inventory_signature(sources)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = backup_root / f"provider-fork-migration-{stamp}"
    suffix = 1
    while backup.exists():
        backup = backup_root / f"provider-fork-migration-{stamp}-{suffix}"
        suffix += 1
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup, 0o700)

    live_state_database = state_database(codex_home)
    sqlite_snapshot(live_state_database, backup / live_state_database.name)
    cc_database = cc_switch_home / "cc-switch.db"
    if cc_database.is_file():
        sqlite_snapshot(cc_database, backup / "cc-switch.db")

    for source, relative in [
        (codex_home / ".codex-global-state.json", "codex-global-state.json"),
        (codex_home / ".codex-global-state.json.bak", "codex-global-state.json.bak"),
        (codex_home / "session_index.jsonl", "session_index.jsonl"),
        (codex_home / "config.toml", "config.toml"),
        (cc_switch_home / "settings.json", "ccswitch-settings.json"),
        (cc_switch_home / "model-pricing.json", "ccswitch-model-pricing.json"),
    ]:
        if source.is_file():
            copy_private(source, backup / relative)

    for source in sources:
        original = Path(source["rollout_path"])
        copy = backup / "source-rollouts" / f"{source['id']}.jsonl"
        copy_private(original, copy)
        if sha256(copy) != source["rollout_sha256"] or validate_jsonl(copy) != source["rollout_lines"]:
            raise MigrationError(f"Backup verification failed for {source['id']}")

    routes_after = route_state(codex_home, cc_switch_home)
    sources_after = source_inventory(codex_home)
    if routes_after != routes_before:
        raise MigrationError("Routing state changed while the backup was being created")
    if inventory_signature(sources_after) != source_signature:
        raise MigrationError("Source task state changed while the backup was being created")

    manifest: dict[str, Any] = {
        "format": 1,
        "created_at": now_iso(),
        "status": "backed_up",
        "codex_home": str(codex_home),
        "cc_switch_home": str(cc_switch_home),
        "state_database": live_state_database.name,
        "source_provider": SOURCE_PROVIDER,
        "target_provider": TARGET_PROVIDER,
        "semantic_version": SEMANTIC_VERSION,
        "routes_before": routes_before,
        "sources": sources,
        "children": {},
    }
    write_json_atomic(backup / "manifest.json", manifest)
    return backup, manifest


class AppServer:
    def __init__(self, codex: Path, codex_home: Path):
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(codex_home)
        environment["CODEX_SQLITE_HOME"] = str(codex_home)
        self.process = subprocess.Popen(
            [str(codex), "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=environment,
        )
        self.next_id = 1
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=50)
        self.selector = selectors.DefaultSelector()
        if self.process.stdout is not None:
            self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        if self.process.stderr is not None:
            self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")

    def close(self) -> None:
        self.selector.close()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def send(self, message: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise MigrationError("App-server stdin unavailable")
        self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any], timeout: float = 180.0) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MigrationError(f"Timed out during {method}: {' | '.join(self.stderr_tail)}")
            for key, _ in self.selector.select(remaining):
                line = key.fileobj.readline()
                if not line:
                    if self.process.poll() is not None:
                        raise MigrationError(f"App-server exited during {method}: {' | '.join(self.stderr_tail)}")
                    continue
                if key.data == "stderr":
                    self.stderr_tail.append(line.rstrip())
                    continue
                response = json.loads(line)
                if response.get("id") != request_id:
                    continue
                if response.get("error") is not None:
                    raise MigrationError(f"{method} failed: {response['error']}")
                result = response.get("result")
                return result if isinstance(result, dict) else {}

    def initialize(self) -> None:
        self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "codex-project-history-migration",
                    "title": "Codex Project History Migration",
                    "version": "1.0.0",
                },
                "capabilities": {"experimentalApi": True},
            },
        )
        self.send({"jsonrpc": "2.0", "method": "initialized", "params": {}})


def thread_path(codex_home: Path, thread_id: str) -> Path:
    connection = sqlite3.connect(f"file:{state_database(codex_home)}?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT rollout_path FROM threads WHERE id = ?", (thread_id,)).fetchone()
    finally:
        connection.close()
    if row is None:
        raise MigrationError(f"No database path for child {thread_id}")
    return Path(row[0])


def verify_child(source: dict[str, Any], child: dict[str, Any], codex_home: Path) -> dict[str, Any]:
    child_id = child["id"]
    rollout = thread_path(codex_home, child_id)
    if not rollout.is_file():
        raise MigrationError(f"Missing child rollout {child_id}")
    lines = validate_jsonl(rollout)
    semantic_count, semantic_prefix_sha = semantic_history(
        rollout, prefix_records=source["semantic_records"]
    )
    meta = first_session_meta(rollout)
    if meta.get("id", meta.get("session_id")) != child_id:
        raise MigrationError(f"Child session id mismatch: {child_id}")
    if meta.get("forked_from_id") != source["id"]:
        raise MigrationError(f"Child lineage mismatch: {child_id}")
    if meta.get("model_provider") != TARGET_PROVIDER or meta.get("cwd") != source["cwd"]:
        raise MigrationError(f"Child provider/cwd mismatch: {child_id}")
    if semantic_count < source["semantic_records"] or semantic_prefix_sha != source["semantic_sha256"]:
        raise MigrationError(f"Model-visible history mismatch: {child_id}")

    connection = sqlite3.connect(f"file:{state_database(codex_home)}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute(
            "SELECT id, model_provider, cwd, archived, source, rollout_path, preview, title, name FROM threads WHERE id = ?",
            (child_id,),
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        raise MigrationError(f"Missing child database row: {child_id}")
    data = dict(row)
    if data["model_provider"] != TARGET_PROVIDER or data["cwd"] != source["cwd"] or data["archived"] != 0:
        raise MigrationError(f"Child database metadata mismatch: {child_id}")
    expected_title = source.get("display_name") or source["title"]
    if data["title"] != expected_title or data["preview"] != source["preview"]:
        raise MigrationError(f"Child title/preview mismatch: {child_id}")
    expected_name = source.get("display_name")
    indexed_name = load_thread_names(codex_home).get(child_id)
    if expected_name and indexed_name != expected_name:
        raise MigrationError(f"Child display-name mismatch: {child_id}")
    if data["name"] not in (None, "", expected_name):
        raise MigrationError(f"Unexpected child database name: {child_id}")
    return {
        "id": child_id,
        "source_id": source["id"],
        "project_id": source["project_id"],
        "cwd": source["cwd"],
        "rollout_path": str(rollout),
        "rollout_bytes": rollout.stat().st_size,
        "rollout_lines": lines,
        "rollout_sha256": sha256(rollout),
        "semantic_records": semantic_count,
        "semantic_prefix_sha256": semantic_prefix_sha,
        "verified_at": now_iso(),
    }


def find_existing_children(codex_home: Path, source_ids: set[str]) -> dict[str, str]:
    connection = sqlite3.connect(f"file:{state_database(codex_home)}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT id, rollout_path, archived FROM threads WHERE model_provider = ?",
            (TARGET_PROVIDER,),
        ).fetchall()
    finally:
        connection.close()
    found: dict[str, str] = {}
    for child_id, rollout_path, archived in rows:
        rollout = Path(rollout_path)
        if not rollout.is_file():
            continue
        meta = first_session_meta(rollout)
        source_id = meta.get("forked_from_id")
        if source_id in source_ids:
            if archived:
                raise MigrationError(
                    f"Archived current-provider child {child_id} already exists for {source_id}"
                )
            if source_id in found and found[source_id] != child_id:
                raise MigrationError(f"Multiple current-provider children for {source_id}")
            found[source_id] = child_id
    return found


def fork_one(codex: Path, codex_home: Path, source: dict[str, Any]) -> dict[str, Any]:
    server = AppServer(codex, codex_home)
    try:
        server.initialize()
        source_read = server.request("thread/read", {"threadId": source["id"], "includeTurns": False})
        source_thread = source_read.get("thread", {})
        status = source_thread.get("status")
        status_type = status.get("type") if isinstance(status, dict) else status
        if status_type in {"active", "inProgress", "running"}:
            raise MigrationError(f"Source is active and cannot be forked safely: {source['id']}")
        result = server.request(
            "thread/fork",
            {
                "threadId": source["id"],
                "modelProvider": TARGET_PROVIDER,
                "cwd": source["cwd"],
                "ephemeral": False,
                "excludeTurns": True,
                "deferGoalContinuation": True,
            },
        )
        thread = result.get("thread")
        if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
            raise MigrationError(f"Invalid fork response for {source['id']}")
        if thread["id"] == source["id"]:
            raise MigrationError(f"Fork reused source id {source['id']}")
        if thread.get("modelProvider") != TARGET_PROVIDER or thread.get("cwd") != source["cwd"]:
            raise MigrationError(f"Fork response metadata mismatch for {source['id']}")
        if thread.get("forkedFromId") != source["id"]:
            raise MigrationError(f"Fork response lineage mismatch for {source['id']}")
        display_name = source.get("display_name")
        if isinstance(display_name, str) and display_name.strip():
            server.request("thread/name/set", {"threadId": thread["id"], "name": display_name.strip()})
        try:
            server.request("thread/unsubscribe", {"threadId": thread["id"]})
        except MigrationError:
            pass
        return thread
    finally:
        server.close()


def verify_route_unchanged(manifest: dict[str, Any], codex_home: Path, cc_switch_home: Path) -> None:
    current = route_state(codex_home, cc_switch_home)
    if current != manifest["routes_before"]:
        raise MigrationError("Codex/CCSwitch routing state changed during migration")


SOURCE_ROW_KEYS = {
    "archived",
    "cwd",
    "history_mode",
    "is_pinned",
    "model",
    "model_provider",
    "name",
    "preview",
    "rollout_path",
    "section_entered_at_ms",
    "section_position",
    "source",
    "thread_section_id",
    "title",
}


def verify_source_unchanged(source: dict[str, Any], codex_home: Path) -> None:
    connection = sqlite3.connect(f"file:{state_database(codex_home)}?mode=ro", uri=True)
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
        raise MigrationError(f"Source row disappeared: {source['id']}")
    current = dict(row)
    for key in SOURCE_ROW_KEYS:
        if current.get(key) != source.get(key):
            raise MigrationError(f"Source metadata changed for {source['id']}: {key}")
    rollout = Path(current["rollout_path"])
    if not rollout.is_file() or rollout.stat().st_size != source["rollout_bytes"]:
        raise MigrationError(f"Source rollout size changed: {source['id']}")
    if sha256(rollout) != source["rollout_sha256"]:
        raise MigrationError(f"Source rollout changed: {source['id']}")
    current_name = load_thread_names(codex_home).get(source["id"])
    expected_name = source.get("display_name")
    if current_name != expected_name:
        raise MigrationError(f"Source display name changed: {source['id']}")


def verify_source_ui_state(backup: Path, codex_home: Path, source_ids: set[str]) -> None:
    original = json.loads((backup / "codex-global-state.json").read_text(encoding="utf-8"))
    current = json.loads(
        (codex_home / ".codex-global-state.json").read_text(encoding="utf-8")
    )
    original_pins = [item for item in original.get("pinned-thread-ids", []) if item in source_ids]
    current_pins = [item for item in current.get("pinned-thread-ids", []) if item in source_ids]
    if current_pins != original_pins:
        raise MigrationError("Source legacy pin state changed before cutover")
    original_assignments = original.get("thread-project-assignments", {})
    current_assignments = current.get("thread-project-assignments", {})
    for source_id in source_ids:
        if current_assignments.get(source_id) != original_assignments.get(source_id):
            raise MigrationError(f"Source project assignment changed: {source_id}")
    for project_id in {CODEX_PROJECT_ID, JAMBO_PROJECT_ID}:
        original_order = [
            item
            for item in original.get("sidebar-project-thread-orders", {})
            .get(project_id, {})
            .get("threadIds", [])
            if item in source_ids
        ]
        current_order = [
            item
            for item in current.get("sidebar-project-thread-orders", {})
            .get(project_id, {})
            .get("threadIds", [])
            if item in source_ids
        ]
        if current_order != original_order:
            raise MigrationError(f"Source project order changed: {project_id}")


def run_migration(
    backup: Path,
    manifest: dict[str, Any],
    codex: Path,
    codex_home: Path,
    cc_switch_home: Path,
    limit: int | None,
) -> dict[str, Any]:
    sources = manifest["sources"]
    if manifest.get("state_database") != state_database(codex_home).name:
        raise MigrationError("The active Codex state database changed since backup")
    source_ids = {source["id"] for source in sources}
    if source_ids != {target["id"] for target in TARGETS}:
        raise MigrationError("Manifest source set does not match the authorized target set")
    verify_route_unchanged(manifest, codex_home, cc_switch_home)
    verify_source_ui_state(backup, codex_home, source_ids)
    for source in sources:
        verify_source_unchanged(source, codex_home)
    existing = find_existing_children(codex_home, source_ids)
    processed = 0
    for source in sources:
        source_id = source["id"]
        child_id = manifest["children"].get(source_id, {}).get("id") or existing.get(source_id)
        if child_id:
            verified = verify_child(source, {"id": child_id}, codex_home)
            manifest["children"][source_id] = verified
            write_json_atomic(backup / "manifest.json", manifest)
            print(f"verified existing {source_id} -> {child_id}", flush=True)
            continue
        if limit is not None and processed >= limit:
            continue
        verify_route_unchanged(manifest, codex_home, cc_switch_home)
        verify_source_unchanged(source, codex_home)
        just_found = find_existing_children(codex_home, source_ids).get(source_id)
        if just_found:
            verified = verify_child(source, {"id": just_found}, codex_home)
            manifest["children"][source_id] = verified
            write_json_atomic(backup / "manifest.json", manifest)
            print(f"verified concurrently-created {source_id} -> {just_found}", flush=True)
            continue
        print(f"forking {source_id} ({source.get('display_name') or source['title'][:60]})", flush=True)
        child = fork_one(codex, codex_home, source)
        verified = verify_child(source, child, codex_home)
        manifest["children"][source_id] = verified
        manifest["status"] = "migrating"
        write_json_atomic(backup / "manifest.json", manifest)
        print(f"created {source_id} -> {child['id']}", flush=True)
        processed += 1
        verify_route_unchanged(manifest, codex_home, cc_switch_home)

    for source in sources:
        verify_source_unchanged(source, codex_home)
    verify_source_ui_state(backup, codex_home, source_ids)
    verify_route_unchanged(manifest, codex_home, cc_switch_home)
    connection = sqlite3.connect(f"file:{state_database(codex_home)}?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise MigrationError("Live state database failed post-migration quick_check")
    finally:
        connection.close()

    if set(manifest["children"]) == source_ids:
        manifest["status"] = "forks_verified"
        manifest["completed_at"] = now_iso()
    write_json_atomic(backup / "manifest.json", manifest)
    return manifest


def upgrade_manifest_semantics(backup: Path, manifest: dict[str, Any]) -> None:
    if manifest.get("semantic_version") == SEMANTIC_VERSION:
        return
    for source in manifest.get("sources", []):
        rollout = backup / "source-rollouts" / f"{source['id']}.jsonl"
        if not rollout.is_file() or sha256(rollout) != source["rollout_sha256"]:
            raise MigrationError(f"Cannot upgrade semantic fingerprint for {source['id']}")
        count, digest = semantic_history(rollout)
        source["semantic_records"] = count
        source["semantic_sha256"] = digest
    manifest["semantic_version"] = SEMANTIC_VERSION
    manifest["semantic_upgraded_at"] = now_iso()
    write_json_atomic(backup / "manifest.json", manifest)


@contextmanager
def migration_lock(codex_home: Path):
    home_digest = hashlib.sha256(str(codex_home).encode("utf-8")).hexdigest()[:16]
    lock_path = Path("/tmp") / f"codex-project-history-migration-{home_digest}.lock"
    with lock_path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise MigrationError("Another project-history migration is already running") from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")))
    parser.add_argument("--cc-switch-home", type=Path, default=Path.home() / ".cc-switch")
    parser.add_argument("--codex", type=Path, default=Path("/Applications/ChatGPT.app/Contents/Resources/codex"))
    parser.add_argument("--backup-root", type=Path, default=Path.home() / ".codex-history-backups")
    parser.add_argument("--resume-backup", type=Path)
    parser.add_argument("--limit", type=int, help="Create at most this many new forks; existing forks are still verified")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    codex_home = args.codex_home.expanduser().resolve()
    cc_switch_home = args.cc_switch_home.expanduser().resolve()
    codex = args.codex.expanduser().resolve()
    if not codex.is_file():
        raise MigrationError(f"Codex binary not found: {codex}")

    with migration_lock(codex_home):
        if args.resume_backup:
            backup = args.resume_backup.expanduser().resolve()
            manifest_path = backup / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("codex_home") != str(codex_home):
                raise MigrationError("Backup belongs to a different CODEX_HOME")
            upgrade_manifest_semantics(backup, manifest)
        else:
            backup_root = args.backup_root.expanduser().resolve()
            backup_root.mkdir(parents=True, mode=0o700, exist_ok=True)
            os.chmod(backup_root, 0o700)
            backup, manifest = create_backup(codex_home, cc_switch_home, backup_root)
            print(f"backup {backup}", flush=True)

        manifest = run_migration(
            backup,
            manifest,
            codex,
            codex_home,
            cc_switch_home,
            args.limit,
        )
    print(f"status {manifest['status']}", flush=True)
    print(f"children {len(manifest['children'])}/{len(manifest['sources'])}", flush=True)
    print(f"manifest {backup / 'manifest.json'}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MigrationError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
