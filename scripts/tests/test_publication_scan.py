"""Black-box tests of the publication scan, run exactly as CI and the pre-push hook run it.

This file is exempt from the scan itself, so it may hold the patterns it tests. It must
never hold a real private term: every term here is made up.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCANNER = Path(__file__).resolve().parents[1] / "publication_scan.py"

FAKE_TERM = "zebracorn"


class Scan:
    def __init__(self, completed: subprocess.CompletedProcess[str]) -> None:
        self.code = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr

    @property
    def findings(self) -> list[str]:
        return [line for line in self.stdout.splitlines() if line]


def _scan(*args: str | Path) -> Scan:
    completed = subprocess.run(
        [sys.executable, str(SCANNER), *(str(arg) for arg in args)],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    return Scan(completed)


def _write(root: Path, relative: str, content: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        check=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        },
    )
    return completed.stdout.strip()


def _commit_all(root: Path, message: str) -> str:
    _git(root, "add", "-A")
    _git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message)
    return _git(root, "rev-parse", "HEAD")


def test_generic_patterns_hit(tmp_path: Path) -> None:
    hits = {
        "internal-reference": [
            "see FR-008",
            "covers SC-004-001",
            "story US5-1",
            "task T001b",
            "feature 012a",
            "read specs/013/plan.md",
            "notes in research-cache.md",
            "contracts/012/api.yaml",
            "the design-review round",
            "the HANDOFF note",
        ],
        "private-product": ["built by nautilus-cloud", "repo nautilus-ui", "nautilus_cloud"],
        "operator-todo": ["TODO(operator): fill in"],
        "account-id": ["account 123456789012", "arn:aws:s3:::some-bucket"],
        "instance-id": ["host i-0abc1234def567890"],
        # Split so that secret scanners reading this file do not flag the fake key.
        "aws-key": ["key AKIA" + "ABCDEFGHIJKLMNOP"],
        "local-path": ["open /Users/someone/file"],
    }
    lines = [line for examples in hits.values() for line in examples]
    _write(tmp_path, "notes.txt", "\n".join(lines) + "\n")

    scan = _scan(tmp_path)

    assert scan.code == 1
    expected = [
        f"notes.txt:{number}: {category}"
        for number, category in enumerate(
            (category for category, examples in hits.items() for _ in examples), start=1
        )
    ]
    assert scan.findings == expected


def test_clean_tree_exits_zero(tmp_path: Path) -> None:
    _write(tmp_path, "src/app.py", "def main() -> None:\n    print('hello')\n")

    scan = _scan(tmp_path)

    assert scan.code == 0
    assert scan.findings == []


def test_uuid_shaped_tokens_never_hit(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "ids.json",
        '{"id": "123e4567-e89b-12d3-a456-426614174000", '
        '"run": "550E8400-E29B-41D4-A716-446655440000"}\n',
    )

    scan = _scan(tmp_path)

    assert scan.code == 0, scan.stdout


def test_zero_account_is_allowed(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "infra.md",
        "account 000000000000\nrole arn:aws:iam::000000000000:role/example\n",
    )

    scan = _scan(tmp_path)

    assert scan.code == 0, scan.stdout


def test_symlinks_are_not_followed_and_escaping_ones_are_reported(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    _write(outside, "leak.txt", "see FR-001\n")
    _write(outside, "dir/leak.txt", "see FR-002\n")
    root = tmp_path / "repo"
    _write(root, "inner/target.txt", "nothing to see\n")
    (root / "to-file").symlink_to(outside / "leak.txt")
    (root / "to-dir").symlink_to(outside / "dir", target_is_directory=True)
    (root / "inner-link").symlink_to(root / "inner" / "target.txt")

    scan = _scan(root)

    assert scan.code == 1
    assert scan.findings == ["to-dir: symlink-escape", "to-file: symlink-escape"]


def test_self_tests_and_gitignore_are_exempt(tmp_path: Path) -> None:
    for relative in (
        "scripts/publication_scan.py",
        "scripts/tests/test_publication_scan.py",
        ".gitignore",
        "apps/web/.gitignore",
        "LICENSE",
        "LICENSES/Other.txt",
        "node_modules/pkg/index.js",
    ):
        _write(tmp_path, relative, "see FR-001 in specs/\n")
    (tmp_path / "image.png").write_bytes(b"\x89PNG\x00FR-001\x00")

    scan = _scan(tmp_path)

    assert scan.code == 0, scan.stdout


def test_allow_marker(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "example.py",
        "BUCKET_OWNER = 123456789012  # publication-scan: allow documented example id\n"
        "OTHER = 210987654321  # publication-scan: allow\n",
    )

    scan = _scan(tmp_path)

    assert scan.code == 1
    assert scan.findings == ["example.py:2: account-id"]


def test_private_terms_file(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", f"# comment\n\n{FAKE_TERM}\nqx\nyy_\n")
    root = tmp_path / "repo"
    _write(
        root,
        "code.py",
        "\n".join(
            [
                f"table = '{FAKE_TERM}_orders'",
                f"layer = 'qx.{FAKE_TERM.upper()}'",
                f"name = 'my{FAKE_TERM}s'",
                "word = 'qxz'",
                f"field = 'orderZebracornId'  # camel {FAKE_TERM}Id",
                "nothing here",
                f"x = 1  # {FAKE_TERM} publication-scan: allow cannot hide a private term",
                "prefix = 'yy_orders'",
                "not_prefix = 'ayy_orders'",
            ]
        )
        + "\n",
    )

    generic_only = _scan(root)
    with_terms = _scan(root, "--terms-file", terms)

    assert generic_only.code == 0
    assert with_terms.code == 1
    assert with_terms.findings == [
        "code.py:1: private-term",
        "code.py:2: private-term",
        "code.py:5: private-term",
        "code.py:7: private-term",
        "code.py:8: private-term",
    ]


def test_terms_file_inside_the_tree_is_not_scanned(tmp_path: Path) -> None:
    terms = _write(tmp_path, "publish/terms.txt", f"{FAKE_TERM}\n")

    scan = _scan(tmp_path, "--terms-file", terms)

    assert scan.code == 0, scan.stdout


def test_term_is_never_printed(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", f"{FAKE_TERM}\n")
    root = tmp_path / "repo"
    _write(root, "a.txt", f"{FAKE_TERM} and FR-001 and 123456789012\n")
    _write(root, "package-lock.json", json.dumps({"resolved": f"https://{FAKE_TERM}.test/x"}))

    scans = [
        _scan(root, "--terms-file", terms),
        _scan(root, "--terms-file", tmp_path / "missing.txt"),
        _scan(root, "--changed", "not-a-range", "--terms-file", terms),
    ]

    for scan in scans:
        output = (scan.stdout + scan.stderr).lower()
        assert FAKE_TERM not in output
        assert "fr-001" not in output
        assert "123456789012" not in output
    assert [scan.code for scan in scans] == [1, 2, 2]


def test_changed_mode_scans_only_the_range(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "master")
    _write(root, "old.txt", "see FR-001\n")
    _write(root, "kept.txt", "fine\n")
    base = _commit_all(root, "base")
    _write(root, "kept.txt", "fine\nnow FR-002\n")
    _write(root, "new.txt", "clean\nFR-005 is pushed even if a later commit drops it\n")
    (root / "old.txt").unlink()
    _commit_all(root, "change")
    _write(root, "new.txt", "clean\n")
    head = _commit_all(root, "drop")
    _write(root, "kept.txt", "fine\nnow FR-002\nuncommitted FR-003\n")
    _write(root, "untracked.txt", "FR-004\n")

    scan = _scan(root, "--changed", f"{base}..{head}")

    assert scan.code == 1
    assert scan.findings == ["kept.txt:2: internal-reference", "new.txt:2: internal-reference"]


def test_changed_mode_from_the_empty_tree_scans_the_first_commit(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "master")
    _write(root, "a.txt", "see FR-001\n")
    head = _commit_all(root, "first")
    empty_tree = _git(root, "hash-object", "-t", "tree", "/dev/null")

    scan = _scan(root, "--changed", f"{empty_tree}..{head}")

    assert scan.findings == ["a.txt:1: internal-reference"]


def test_changed_mode_reports_escaping_symlinks(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "master")
    _write(root, "a.txt", "fine\n")
    base = _commit_all(root, "base")
    (root / "escape").symlink_to("../../outside")
    (root / "inside").symlink_to("a.txt")
    head = _commit_all(root, "links")

    scan = _scan(root, "--changed", f"{base}..{head}")

    assert scan.code == 1
    assert scan.findings == ["escape: symlink-escape"]


def test_lockfile_hosts_outside_allowlist_hit(tmp_path: Path) -> None:
    npm_lock = {
        "packages": {
            "": {"name": "root"},
            "node_modules/web": {"resolved": "apps/web", "link": True},
            "node_modules/ok": {"resolved": "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz"},
            "node_modules/bad": {"resolved": "https://npm.internal.test/bad/-/bad-1.0.0.tgz"},
            "node_modules/git": {"resolved": "git+ssh://git@github.com/acme/git.git#abc"},
            "node_modules/file": {"resolved": "file:../vendor/file.tgz"},
        }
    }
    _write(tmp_path, "package-lock.json", json.dumps(npm_lock, indent=2) + "\n")
    _write(
        tmp_path,
        "apps/api/uv.lock",
        "\n".join(
            [
                "version = 1",
                "",
                "[[package]]",
                'name = "app"',
                'source = { virtual = "." }',
                "",
                "[[package]]",
                'name = "ok"',
                'source = { registry = "https://pypi.org/simple" }',
                'sdist = { url = "https://files.pythonhosted.org/ok-1.0.tar.gz" }',
                "",
                "[[package]]",
                'name = "bad"',
                'source = { registry = "https://pypi.internal.test/simple" }',
                'wheels = [{ url = "https://files.pythonhosted.org/bad-1.0.whl" }]',
                "",
                "[[package]]",
                'name = "vcs"',
                'source = { git = "https://git.internal.test/vcs.git?rev=abc" }',
                "",
                "# FR-001 is not scanned as text inside a lockfile",
            ]
        )
        + "\n",
    )

    scan = _scan(tmp_path)

    assert scan.code == 1
    assert scan.findings == [
        "apps/api/uv.lock:14: lockfile-host",
        "apps/api/uv.lock:19: lockfile-host",
        "package-lock.json:14: lockfile-host",
        "package-lock.json:17: lockfile-host",
        "package-lock.json:20: lockfile-host",
    ]


def test_exempt_files_are_still_checked_for_private_terms(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", f"{FAKE_TERM}\n")
    root = tmp_path / "repo"
    for relative in (
        "scripts/publication_scan.py",
        "scripts/tests/test_publication_scan.py",
        ".gitignore",
        "LICENSE",
        "LICENSES/Other.txt",
    ):
        _write(root, relative, f"see FR-001\n{FAKE_TERM}\n")

    scan = _scan(root, "--terms-file", terms)

    assert scan.findings == [
        ".gitignore:2: private-term",
        "LICENSE:2: private-term",
        "LICENSES/Other.txt:2: private-term",
        "scripts/publication_scan.py:2: private-term",
        "scripts/tests/test_publication_scan.py:2: private-term",
    ]


def test_private_term_in_path_is_reported_without_the_path(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", f"{FAKE_TERM}\n")
    root = tmp_path / "repo"
    _write(root, f"data/{FAKE_TERM}_orders/part.txt", "see FR-001\n")
    _write(root, f"src/{FAKE_TERM.capitalize()}Page.tsx", "clean\n")
    _write(root, "specs/notes.txt", "clean\n")
    (root / f"{FAKE_TERM}-link").symlink_to(tmp_path / "private")

    scan = _scan(root, "--terms-file", terms)

    output = (scan.stdout + scan.stderr).lower()
    assert scan.code == 1
    assert FAKE_TERM not in output
    categories = sorted(line.split(": ", 1)[1] for line in scan.findings)
    assert categories == [
        "internal-reference",
        "internal-reference-in-path",
        "private-term-in-path",
        "private-term-in-path",
        "private-term-in-path",
        "symlink-escape",
    ]
    hashed = [line for line in scan.findings if line.startswith("sha256:")]
    assert len(hashed) == 5
    assert "specs/notes.txt: internal-reference-in-path" in scan.findings


def test_lockfiles_get_product_path_and_term_rules(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", f"{FAKE_TERM}\n")
    root = tmp_path / "repo"
    npm_lock = {
        "name": "nautilus-ui",
        "packages": {
            "": {"name": "nautilus-ui", "description": f"{FAKE_TERM} FR-001 123456789012"},
            "node_modules/x": {"resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"},
        },
    }
    _write(root, "package-lock.json", json.dumps(npm_lock, indent=2) + "\n")
    _write(
        root,
        "uv.lock",
        'version = 1\n# built in /Users/someone/src\n[[package]]\nname = "app"\n'
        'source = { virtual = "." }\n',
    )

    scan = _scan(root, "--terms-file", terms)

    assert scan.findings == [
        "package-lock.json:2: private-product",
        "package-lock.json:5: private-product",
        "package-lock.json:6: private-term",
        "uv.lock:2: local-path",
    ]


def test_identifier_only_terms(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", "# comment\nid:quokka\n")
    root = tmp_path / "repo"
    lines = {
        "The quokka is a small marsupial.": False,
        "Quokka: a sentence that starts with it.": False,
        "we saw a quokka.": False,
        "a quokka - and a dash": False,
        "table = quokka_orders": True,
        "schema core.quokka": True,
        "tag source:quokka": True,
        "path data/quokka/part": True,
        "kind = orderQuokkaId": True,
        "ts: QuokkaPage": True,
        'kind = "quokka"': True,
        "`quokka`": True,
        "a 'Quokka' literal": True,
        "quokkas are many": False,
    }
    _write(root, "notes.txt", "\n".join(lines) + "\n")

    scan = _scan(root, "--terms-file", terms)

    expected = [
        f"notes.txt:{number}: private-term"
        for number, hits in enumerate(lines.values(), start=1)
        if hits
    ]
    assert scan.findings == expected


def test_binary_files_are_checked_for_private_terms(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", f"{FAKE_TERM}\n")
    root = tmp_path / "repo"
    root.mkdir()
    (root / "latin.bin").write_bytes(b"\x00\x01garbage " + FAKE_TERM.encode() + b" end\x00")
    (root / "wide.txt").write_bytes(f"name = {FAKE_TERM}_x\n".encode("utf-16"))
    (root / "clean.bin").write_bytes(b"\x00\x01FR-001 nothing\x00")

    scan = _scan(root, "--terms-file", terms)

    assert scan.findings == ["latin.bin: private-term", "wide.txt: private-term"]


def test_non_regular_files_are_ignored(tmp_path: Path) -> None:
    os.mkfifo(tmp_path / "pipe")
    _write(tmp_path, "a.txt", "clean\n")

    scan = _scan(tmp_path)

    assert scan.code == 0, scan.stdout + scan.stderr


def test_symlink_loops_are_reported(tmp_path: Path) -> None:
    (tmp_path / "a").symlink_to(tmp_path / "b")
    (tmp_path / "b").symlink_to(tmp_path / "a")

    scan = _scan(tmp_path)

    assert scan.findings == ["a: symlink-loop", "b: symlink-loop"]
    assert "Traceback" not in scan.stderr


def test_changed_mode_skips_the_terms_file_in_use(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "master")
    _write(root, "publish/terms.txt", f"{FAKE_TERM}\n")
    base = _commit_all(root, "base")
    _write(root, "publish/terms.txt", f"{FAKE_TERM}\nquokka\n")
    head = _commit_all(root, "more terms")

    in_use = _scan(root, "--changed", f"{base}..{head}", "--terms-file", root / "publish/terms.txt")
    other = _write(tmp_path, "other-terms.txt", f"{FAKE_TERM}\n")
    not_in_use = _scan(root, "--changed", f"{base}..{head}", "--terms-file", other)

    assert in_use.code == 0, in_use.stdout
    assert not_in_use.findings == ["publish/terms.txt:1: private-term"]


HOOK = SCANNER.parent / "hooks" / "pre-push"


def _hook_repo(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote))
    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "-q", "-b", "master")
    hooks = work / "scripts" / "hooks"
    hooks.mkdir(parents=True)
    (work / "scripts" / "publication_scan.py").write_bytes(SCANNER.read_bytes())
    (hooks / "pre-push").write_bytes(HOOK.read_bytes())
    (hooks / "pre-push").chmod(0o755)
    _git(work, "config", "core.hooksPath", "scripts/hooks")
    _git(work, "remote", "add", "origin", str(remote))
    return work


def _push(work: Path, home: Path, terms: Path | None, branch: str = "master") -> int:
    env = {key: value for key, value in os.environ.items() if key != "PERIPLO_PUBLICATION_TERMS"}
    env["HOME"] = str(home)
    if terms is not None:
        env["PERIPLO_PUBLICATION_TERMS"] = str(terms)
    completed = subprocess.run(
        ["git", "-C", str(work), "push", "-q", "origin", branch],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    assert FAKE_TERM not in (completed.stdout + completed.stderr).lower()
    return completed.returncode


def test_pre_push_hook_without_terms_accepts_a_clean_new_branch(tmp_path: Path) -> None:
    work = _hook_repo(tmp_path)
    _write(work, "a.txt", "clean\n")
    _commit_all(work, "init")

    assert _push(work, tmp_path / "home", None) == 0


def test_pre_push_hook_blocks_terms_and_fails_closed(tmp_path: Path) -> None:
    work = _hook_repo(tmp_path)
    home = tmp_path / "home"
    _write(work, "a.txt", "clean\n")
    _commit_all(work, "init")
    assert _push(work, home, tmp_path / "missing.txt") != 0

    _write(work, "publish/terms.txt", f"{FAKE_TERM}\n")
    _commit_all(work, "terms")
    assert _push(work, home, None) == 0

    _write(work, "b.txt", f"table {FAKE_TERM}_orders\n")
    _commit_all(work, "leak")
    assert _push(work, home, None) != 0


def test_hash_tokens_never_hit(tmp_path: Path) -> None:
    terms = _write(tmp_path / "private", "terms.txt", "qx\n")
    root = tmp_path / "repo"
    _write(
        root,
        "package-lock.json",
        json.dumps({"packages": {"": {"integrity": "sha512-Ab9+QX+cd/QX=="}}}, indent=2) + "\n",
    )
    _write(root, "hashes.txt", 'hash = "sha256:0123abcd"\nrev ' + "ab" * 20 + "\nsee qx-2\n")

    scan = _scan(root, "--terms-file", terms)

    assert scan.findings == ["hashes.txt:3: private-term"]
