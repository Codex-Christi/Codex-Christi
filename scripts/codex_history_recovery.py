#!/usr/bin/env python3
"""Safely back up and inventory Codex history across every model provider.

The script is deliberately provider-neutral. It does not switch or rewrite the
active model provider, CCSwitch/Kimi routes, session metadata, or transcripts.
It makes transactionally consistent snapshots of live SQLite databases, copies
validated JSONL transcript snapshots, and invokes Codex's supported app-server
thread/list scan with an explicit empty modelProviders list (all providers).

This is not a destructive physical restore utility. Restoring the already-intact
files cannot fix a desktop-client provider filter, and overwriting live Codex or
CCSwitch state would be unsafe.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import selectors
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


DEFAULT_CODEX = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
DEFAULT_BACKUP_ROOT = Path.home() / ".codex-history-backups"
DEFAULT_CC_SWITCH_HOME = Path.home() / ".cc-switch"
ALL_SOURCE_KINDS = [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
]
INTERACTIVE_SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"]
CODEX_HISTORY_DIRECTORIES = [
    "sessions",
    "archived_sessions",
    "attachments",
    "generated_images",
    "visualizations",
]
CODEX_STATE_FILES = [
    "config.toml",
    "session_index.jsonl",
    ".codex-global-state.json",
    ".codex-global-state.json.bak",
    "cc-switch-model-catalog.json",
    "version.json",
]
ROUTING_FILES = ["config.toml", "cc-switch-model-catalog.json"]
CC_SWITCH_ROUTING_FILES = ["settings.json", "model-pricing.json"]


class RecoveryError(RuntimeError):
    pass


def log(message: str) -> None:
    print(message, flush=True)


def resolve_codex_binary(value: str | None) -> Path:
    if value:
        candidate = Path(value).expanduser().resolve()
    elif DEFAULT_CODEX.is_file():
        candidate = DEFAULT_CODEX
    else:
        found = shutil.which("codex")
        if not found:
            raise RecoveryError("Could not locate the Codex executable.")
        candidate = Path(found).resolve()
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise RecoveryError(f"Codex executable is not runnable: {candidate}")
    return candidate


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_private_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def run_doctor(codex: Path) -> dict[str, Any]:
    environment = os.environ.copy()
    environment.setdefault("TERM", "xterm-256color")
    result = subprocess.run(
        [str(codex), "doctor", "--json"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=120,
        env=environment,
    )
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RecoveryError(
            f"Codex doctor did not return valid JSON (exit {result.returncode}): "
            f"{result.stderr.strip()}"
        ) from exc
    if not isinstance(report, dict):
        raise RecoveryError("Codex doctor returned an unexpected report shape.")
    report["_process"] = {
        "exit_code": result.returncode,
        "stderr": result.stderr.strip(),
    }
    return report


def effective_state_paths(doctor: dict[str, Any]) -> tuple[Path, Path]:
    try:
        details = doctor["checks"]["config.load"]["details"]
        codex_home = Path(details["CODEX_HOME"]).expanduser().resolve()
        sqlite_home = Path(details["sqlite home"]).expanduser().resolve()
    except (KeyError, TypeError) as exc:
        raise RecoveryError("Codex doctor did not report effective state paths.") from exc
    if not codex_home.is_dir():
        raise RecoveryError(f"Effective CODEX_HOME does not exist: {codex_home}")
    if not sqlite_home.is_dir():
        raise RecoveryError(f"Effective SQLite home does not exist: {sqlite_home}")
    return codex_home, sqlite_home


def is_sqlite_database(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    try:
        with path.open("rb") as handle:
            return handle.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def sqlite_snapshot(source: Path, destination: Path) -> dict[str, Any]:
    """Create and integrity-check a transactionally consistent live DB copy."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_uri = source.resolve().as_uri() + "?mode=ro"
    source_db = sqlite3.connect(source_uri, uri=True, timeout=60.0)
    destination_db = sqlite3.connect(str(destination), timeout=60.0)
    try:
        source_db.execute("PRAGMA query_only = ON")
        source_db.backup(destination_db, pages=256, sleep=0.05)
        result = destination_db.execute("PRAGMA quick_check").fetchone()
        if result is None or result[0] != "ok":
            raise RecoveryError(f"SQLite snapshot failed integrity check: {source}")
    finally:
        destination_db.close()
        source_db.close()
    shutil.copystat(source, destination, follow_symlinks=False)
    return {
        "kind": "sqlite-backup-api",
        "source": str(source),
        "destination": str(destination),
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
        "quick_check": "ok",
    }


def validate_jsonl(path: Path) -> int:
    lines = 0
    with path.open("rb") as handle:
        for line in handle:
            if not line.strip():
                raise RecoveryError(f"Blank JSONL record in snapshot: {path}")
            try:
                json.loads(line)
            except json.JSONDecodeError as exc:
                raise RecoveryError(
                    f"Invalid JSONL snapshot record at {path}:{lines + 1}"
                ) from exc
            lines += 1
    return lines


def file_snapshot(
    source: Path,
    destination: Path,
    *,
    validate_as_jsonl: bool = False,
    attempts: int = 5,
) -> dict[str, Any]:
    """Copy a stable prefix of a regular file without modifying the source."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.parent / f".{destination.name}.partial-{os.getpid()}"
    last_error: BaseException | None = None
    for attempt in range(attempts):
        try:
            before = source.stat()
            remaining = before.st_size
            digest = hashlib.sha256()
            with source.open("rb") as reader, partial.open("wb") as writer:
                while remaining:
                    chunk = reader.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RecoveryError(f"Source shrank while being copied: {source}")
                    writer.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                writer.flush()
                os.fsync(writer.fileno())
            after = source.stat()
            if before.st_ino != after.st_ino or after.st_size < before.st_size:
                raise RecoveryError(f"Source was replaced while being copied: {source}")
            line_count = validate_jsonl(partial) if validate_as_jsonl else None
            os.chmod(partial, stat.S_IMODE(before.st_mode))
            partial.replace(destination)
            return {
                "kind": "validated-jsonl-prefix" if validate_as_jsonl else "file-snapshot",
                "source": str(source),
                "destination": str(destination),
                "bytes": before.st_size,
                "sha256": digest.hexdigest(),
                "jsonl_records": line_count,
                "source_grew_after_snapshot": after.st_size > before.st_size,
            }
        except (OSError, RecoveryError) as exc:
            last_error = exc
            partial.unlink(missing_ok=True)
            if attempt + 1 < attempts:
                time.sleep(0.1 * (attempt + 1))
    raise RecoveryError(f"Could not snapshot {source}: {last_error}")


def tree_snapshot(
    source: Path,
    destination: Path,
    records: list[dict[str, Any]],
    *,
    skip_top_level: set[str] | None = None,
) -> None:
    """Snapshot regular files under a tree, safely ignoring volatile endpoints."""
    if not source.is_dir():
        return
    skip_top_level = skip_top_level or set()
    for path in sorted(source.rglob("*")):
        try:
            relative = path.relative_to(source)
            if relative.parts and relative.parts[0] in skip_top_level:
                continue
            mode = os.lstat(path).st_mode
        except FileNotFoundError:
            continue
        target = destination / relative
        if stat.S_ISDIR(mode):
            target.mkdir(parents=True, exist_ok=True)
            continue
        if stat.S_ISLNK(mode):
            records.append({"kind": "skipped-symlink", "source": str(path)})
            continue
        if not stat.S_ISREG(mode):
            records.append({"kind": "skipped-runtime-file", "source": str(path)})
            continue
        if path.name.endswith(("-wal", "-shm", "-journal")):
            database_name = path.name.rsplit("-", 1)[0]
            if is_sqlite_database(path.parent / database_name):
                continue
        if is_sqlite_database(path):
            records.append(sqlite_snapshot(path, target))
        else:
            records.append(
                file_snapshot(path, target, validate_as_jsonl=path.suffix == ".jsonl")
            )


def routing_fingerprint(codex_home: Path, cc_switch_home: Path) -> dict[str, str]:
    fingerprints: dict[str, str] = {}
    for name in ROUTING_FILES:
        path = codex_home / name
        if path.is_file():
            fingerprints[f"codex/{name}"] = sha256(path)
    for name in CC_SWITCH_ROUTING_FILES:
        path = cc_switch_home / name
        if path.is_file():
            fingerprints[f"ccswitch/{name}"] = sha256(path)
    return fingerprints


def transcript_counts(codex_home: Path) -> dict[str, int]:
    sessions = codex_home / "sessions"
    archived = codex_home / "archived_sessions"
    return {
        "active_transcripts": len(list(sessions.rglob("*.jsonl"))) if sessions.is_dir() else 0,
        "archived_transcripts": len(list(archived.rglob("*.jsonl"))) if archived.is_dir() else 0,
    }


def database_sources(codex_home: Path, sqlite_home: Path) -> list[tuple[Path, Path]]:
    """Return history/catalog DB sources and their relative backup destinations."""
    candidates: dict[Path, Path] = {}
    for path in sqlite_home.glob("state_*.sqlite"):
        candidates[path.resolve()] = Path("sqlite_home") / path.name
    embedded_sqlite = codex_home / "sqlite"
    if embedded_sqlite.is_dir():
        for path in embedded_sqlite.iterdir():
            if path.is_file() and is_sqlite_database(path):
                candidates[path.resolve()] = Path("codex_home") / "sqlite" / path.name
    for path in codex_home.glob("state_*.sqlite"):
        candidates[path.resolve()] = Path("codex_home") / path.name
    return sorted(candidates.items(), key=lambda pair: str(pair[0]))


def make_backup(
    codex_home: Path,
    sqlite_home: Path,
    cc_switch_home: Path,
    backup_root: Path,
    doctor_before: dict[str, Any],
) -> Path:
    protected_roots = [codex_home, sqlite_home, cc_switch_home]
    for protected in protected_roots:
        if backup_root == protected or backup_root.is_relative_to(protected):
            raise RecoveryError(f"Backup destination must be outside {protected}.")
    backup_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    final = backup_root / f"codex-history-{stamp}"
    suffix = 1
    while final.exists():
        final = backup_root / f"codex-history-{stamp}-{suffix}"
        suffix += 1
    staging = Path(tempfile.mkdtemp(prefix=f".{final.name}.", dir=backup_root))
    os.chmod(staging, 0o700)
    records: list[dict[str, Any]] = []
    try:
        log("Backing up validated Codex transcripts and UI history state ...")
        for name in CODEX_HISTORY_DIRECTORIES:
            tree_snapshot(codex_home / name, staging / "codex_home" / name, records)
        for name in CODEX_STATE_FILES:
            source = codex_home / name
            if source.is_file():
                records.append(
                    file_snapshot(
                        source,
                        staging / "codex_home" / name,
                        validate_as_jsonl=source.suffix == ".jsonl",
                    )
                )
        for source, relative in database_sources(codex_home, sqlite_home):
            records.append(sqlite_snapshot(source, staging / relative))
        if cc_switch_home.is_dir():
            log("Backing up CCSwitch/Kimi routing state without modifying it ...")
            tree_snapshot(
                cc_switch_home,
                staging / "cc_switch_home",
                records,
                skip_top_level={"logs"},
            )
        for record in records:
            destination = record.get("destination")
            if destination:
                record["destination"] = str(Path(destination).relative_to(staging))
        write_private_json(staging / "doctor-before.json", doctor_before)
        manifest = {
            "format": 2,
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "backup_kind": "live validated transcript snapshots plus consistent SQLite snapshots",
            "not_global_point_in_time": True,
            "auth_tokens_included": False,
            "codex_home": str(codex_home),
            "sqlite_home": str(sqlite_home),
            "cc_switch_home": str(cc_switch_home) if cc_switch_home.is_dir() else None,
            "records": records,
        }
        write_private_json(staging / "manifest.json", manifest)
        staging.rename(final)
        os.chmod(final, 0o700)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    log(f"Live-safe backup created: {final}")
    return final


class AppServer:
    def __init__(self, codex: Path):
        self.process = subprocess.Popen(
            [str(codex), "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
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
            raise RecoveryError("Codex app-server stdin is unavailable.")
        self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                detail = "\n".join(self.stderr_tail)
                raise RecoveryError(f"Timed out waiting for {method}. {detail}")
            events = self.selector.select(remaining)
            if not events:
                continue
            for key, _ in events:
                line = key.fileobj.readline()
                if not line:
                    if self.process.poll() is not None:
                        detail = "\n".join(self.stderr_tail)
                        raise RecoveryError(f"Codex app-server exited during {method}. {detail}")
                    continue
                if key.data == "stderr":
                    self.stderr_tail.append(line.rstrip())
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RecoveryError(f"Invalid app-server JSON during {method}.") from exc
                if payload.get("id") != request_id:
                    continue
                if payload.get("error") is not None:
                    raise RecoveryError(f"App-server {method} failed: {payload['error']}")
                result = payload.get("result", {})
                return result if isinstance(result, dict) else {}


def list_threads(
    server: AppServer,
    *,
    archived: bool,
    source_kinds: list[str],
) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    while True:
        result = server.request(
            "thread/list",
            {
                "archived": archived,
                "cursor": cursor,
                "limit": 100,
                "modelProviders": [],
                "sortDirection": "desc",
                "sortKey": "created_at",
                "sourceKinds": source_kinds,
                "useStateDbOnly": False,
            },
        )
        for row in result.get("data", []):
            if isinstance(row, dict) and row.get("id"):
                rows[str(row["id"])] = row
        cursor = result.get("nextCursor")
        if not cursor:
            return list(rows.values())


def all_provider_inventory(codex: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    server = AppServer(codex)
    try:
        server.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "codex-history-recovery",
                    "title": "Codex History Recovery",
                    "version": "2.0.0",
                },
                "capabilities": {"experimentalApi": True},
            },
        )
        server.send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        all_active = list_threads(server, archived=False, source_kinds=ALL_SOURCE_KINDS)
        interactive_active = list_threads(
            server, archived=False, source_kinds=INTERACTIVE_SOURCE_KINDS
        )
        interactive_archived = list_threads(
            server, archived=True, source_kinds=INTERACTIVE_SOURCE_KINDS
        )
        return all_active, interactive_active, interactive_archived
    finally:
        server.close()


def provider_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        provider = str(row.get("modelProvider") or "unknown")
        counts[provider] = counts.get(provider, 0) + 1
    return dict(sorted(counts.items()))


def task_name(row: dict[str, Any]) -> str:
    value = row.get("name") or row.get("preview") or "Untitled task"
    return " ".join(str(value).split())


def write_inventory_markdown(path: Path, rows: list[dict[str, Any]], project: Path | None) -> None:
    title = f"Codex history for {project}" if project else "Codex all-provider history"
    lines = [
        f"# {title}",
        "",
        "This inventory preserves each task's original provider. It does not switch routing.",
        "",
        "| Task | Provider | Task ID | Direct CLI access |",
        "|---|---|---|---|",
    ]
    for row in sorted(rows, key=lambda item: str(item.get("createdAt") or ""), reverse=True):
        name = task_name(row).replace("|", "\\|")
        provider = str(row.get("modelProvider") or "unknown").replace("|", "\\|")
        task_id = str(row.get("id") or "")
        lines.append(f"| {name} | {provider} | `{task_id}` | `codex resume {task_id}` |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def build_recovery_report(
    codex: Path,
    backup: Path,
    project: Path | None,
    routing_before: dict[str, str],
    codex_home: Path,
    cc_switch_home: Path,
) -> dict[str, Any]:
    all_active, interactive_active, interactive_archived = all_provider_inventory(codex)
    doctor_after = run_doctor(codex)
    write_private_json(backup / "doctor-after.json", doctor_after)
    project_rows: list[dict[str, Any]] = []
    if project is not None:
        project_path = str(project.resolve())
        project_rows = [row for row in interactive_active if row.get("cwd") == project_path]
    routing_after = routing_fingerprint(codex_home, cc_switch_home)
    report = {
        "backup": str(backup),
        "operation": "provider-neutral JSONL metadata scan plus all-provider inventory",
        "physical_restore_performed": False,
        "reason_no_physical_restore": "history is intact; overwriting it cannot fix a client-side provider filter",
        "routing_unchanged": routing_before == routing_after,
        "routing_before": routing_before,
        "routing_after": routing_after,
        "all_active_rows_scanned": len(all_active),
        "interactive_active_tasks": len(interactive_active),
        "interactive_archived_tasks": len(interactive_archived),
        "interactive_active_provider_counts": provider_counts(interactive_active),
        "interactive_archived_provider_counts": provider_counts(interactive_archived),
        "project": str(project.resolve()) if project is not None else None,
        "project_active_tasks": len(project_rows),
        "project_provider_counts": provider_counts(project_rows),
        "project_tasks": [
            {
                "id": row.get("id"),
                "name": task_name(row),
                "provider": row.get("modelProvider"),
                "cwd": row.get("cwd"),
            }
            for row in project_rows
        ],
        "doctor_after": doctor_after,
    }
    write_private_json(backup / "recovery-report.json", report)
    write_inventory_markdown(
        backup / "all-provider-history.md",
        project_rows if project is not None else interactive_active,
        project,
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup-root", type=Path, default=DEFAULT_BACKUP_ROOT)
    parser.add_argument("--cc-switch-home", type=Path, default=DEFAULT_CC_SWITCH_HOME)
    parser.add_argument("--codex-binary")
    parser.add_argument("--project", type=Path)
    parser.add_argument(
        "--backup-only",
        action="store_true",
        help="Create the backup but skip the supported metadata scan/inventory.",
    )
    args = parser.parse_args()

    codex = resolve_codex_binary(args.codex_binary)
    doctor_before = run_doctor(codex)
    codex_home, sqlite_home = effective_state_paths(doctor_before)
    cc_switch_home = args.cc_switch_home.expanduser().resolve()
    backup_root = args.backup_root.expanduser().resolve()
    routing_before = routing_fingerprint(codex_home, cc_switch_home)
    transcript_counts_before = transcript_counts(codex_home)
    backup = make_backup(
        codex_home,
        sqlite_home,
        cc_switch_home,
        backup_root,
        doctor_before,
    )
    if args.backup_only:
        log("Backup-only mode completed; no metadata scan was run.")
        return 0

    log("Scanning history with all providers explicitly enabled ...")
    report = build_recovery_report(
        codex,
        backup,
        args.project,
        routing_before,
        codex_home,
        cc_switch_home,
    )
    transcript_counts_after = transcript_counts(codex_home)
    if not report["routing_unchanged"]:
        raise RecoveryError("Safety check failed: a routing configuration file changed.")
    if transcript_counts_before["active_transcripts"] > transcript_counts_after["active_transcripts"]:
        raise RecoveryError("Safety check failed: active transcript count decreased.")
    if transcript_counts_before["archived_transcripts"] > transcript_counts_after["archived_transcripts"]:
        raise RecoveryError("Safety check failed: archived transcript count decreased.")

    log("Completed without switching or rewriting OpenAI/CCSwitch routing.")
    log(f"Interactive tasks by provider: {report['interactive_active_provider_counts']}")
    if args.project is not None:
        log(f"Project tasks by provider: {report['project_provider_counts']}")
    log(f"Recovery report: {backup / 'recovery-report.json'}")
    log(f"All-provider inventory: {backup / 'all-provider-history.md'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        RecoveryError,
        OSError,
        sqlite3.Error,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
