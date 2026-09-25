"""Find what must not be published: internal references, account ids, keys and private terms.

Usage::

    python3 scripts/publication_scan.py [ROOT] [--terms-file FILE] [--changed BASE..HEAD]

Without ``--changed`` the tree under ``ROOT`` is walked without following symlinks. With it,
every commit in the range is read: the files each one adds or modifies, as that commit has
them, so a leak that a later commit removes is still found. ``BASE`` may be the empty tree.

Findings are printed as ``path:line: category`` and never include the matched text, so the
output is safe to show in public CI logs even when a private term is found. A path that
itself contains a private term is shown as ``sha256:<first 12 hex digits of the path>``;
``git ls-files | while read -r p; do printf '%s ' "$(printf %s "$p" | shasum -a 256)"; echo
"$p"; done`` finds it locally. Exit codes: 0 clean, 1 findings, 2 usage or input error.

Private terms are checked everywhere, paths included. The generic rules skip this scanner,
its test, ``.gitignore`` and licence files, and a line carrying ``publication-scan: allow
<reason>``; nothing exempts a private term, because it would be published anyway. The terms
file in use is never scanned. Lockfiles only get the product, local-path and term rules as
text, and every package URL in them must come from an allowed host. Binary files are only
checked for private terms, in their printable runs (ASCII and UTF-16).

Only the standard library (Python 3.11+) is used, so CI and the pre-push hook need nothing
installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import stat
import subprocess
import sys
import tomllib
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

SELF_EXEMPT = frozenset({"scripts/publication_scan.py", "scripts/tests/test_publication_scan.py"})
SKIPPED_DIRS = frozenset({".git", "node_modules"})
ALLOWED_LOCK_HOSTS = frozenset({"registry.npmjs.org", "pypi.org", "files.pythonhosted.org"})
NPM_LOCK = "package-lock.json"
UV_LOCK = "uv.lock"
UV_LOCK_URL_KEYS = frozenset({"url", "registry", "git"})
GIT_SYMLINK_MODE = "120000"
GIT_ERROR = "cannot read the range from git; is it BASE..HEAD in a repository?"
IDENTIFIER_PREFIX = "id:"
JOINERS = "_.-/:"
QUOTES = "\"'`"

# Opaque tokens whose letters are random: UUIDs, integrity hashes and long hex digests.
OPAQUE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
    r"|\bsha(?:1|256|384|512)[-:][A-Za-z0-9+/=]+|\b[0-9a-f]{40,}\b",
    re.I,
)
ALLOW_MARKER = re.compile(r"publication-scan:\s*allow\s+\S")
ZERO_ACCOUNT = "000000000000"

INTERNAL_REFERENCE = (
    "internal-reference",
    re.compile(
        r"\b(?:FR|SC)-\d{3}(?:-\d{3})?\b|\bUS\d{1,2}(?:-\d)?\b|\bT\d{3}[a-z]?\b|\b01\d[a-z]\b"
        r"|specs/|research-[a-z]+\.md|contracts/0\d\d/|design-review|HANDOFF"
    ),
)
PRIVATE_PRODUCT = ("private-product", re.compile(r"nautilus[-_ ]cloud|nautilus-ui", re.I))
LOCAL_PATH = ("local-path", re.compile(r"/Users/"))

Rule = tuple[str, re.Pattern[str]]
GENERIC_RULES: tuple[Rule, ...] = (
    INTERNAL_REFERENCE,
    PRIVATE_PRODUCT,
    ("operator-todo", re.compile(r"TODO\(operator\)")),
    ("instance-id", re.compile(r"\bi-0[0-9a-f]{8,17}\b")),
    ("aws-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    LOCAL_PATH,
)
LOCKFILE_RULES: tuple[Rule, ...] = (PRIVATE_PRODUCT, LOCAL_PATH)
PATH_RULES: tuple[Rule, ...] = (INTERNAL_REFERENCE, PRIVATE_PRODUCT)
ACCOUNT_ID = re.compile(r"\b\d{12}\b")
ARN = re.compile(r"\barn:aws[a-z-]*:[^\s\"'`<>]*")

NPM_RESOLVED_LINE = re.compile(r'"resolved"\s*:\s*"([^"]*)"')
UV_URL_LINE = re.compile(r'\b(?:url|registry|git)\s*=\s*"([^"]*)"')
ASCII_RUN = re.compile(rb"[\x20-\x7e\t]{4,}")
UTF16_LE_RUN = re.compile(rb"(?:[\x20-\x7e]\x00){4,}")
UTF16_BE_RUN = re.compile(rb"(?:\x00[\x20-\x7e]){4,}")


class ScanError(Exception):
    """An input problem; its message never contains scanned content or a private term."""


class Finding(NamedTuple):
    path: str
    line: int
    category: str

    def render(self) -> str:
        if self.line == 0:
            return f"{self.path}: {self.category}"
        return f"{self.path}:{self.line}: {self.category}"


@dataclass(frozen=True)
class Term:
    pattern: re.Pattern[str]
    identifier_only: bool


@dataclass(frozen=True)
class Rules:
    terms: tuple[Term, ...]
    terms_file_paths: frozenset[str]


def load_terms(path: Path) -> tuple[Term, ...]:
    """One literal term per line; ``#`` comments and blank lines are ignored.

    ``id:<term>`` matches the term only where it is used as an identifier (see
    ``_is_identifier_use``), for terms that are also ordinary words.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ScanError(f"cannot read the terms file {path}") from error
    terms: list[Term] = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        identifier_only = line.startswith(IDENTIFIER_PREFIX)
        literal = line.removeprefix(IDENTIFIER_PREFIX).strip() if identifier_only else line
        if literal:
            pattern = re.compile(f"(?=({re.escape(literal)}))", re.I)
            terms.append(Term(pattern, identifier_only))
    return tuple(terms)


def _is_whole_token(text: str, start: int, end: int) -> bool:
    """Bounded by non-alphanumerics or by a camelCase change.

    A side of the term that is not alphanumeric itself (``xy_``) needs no boundary there.
    """
    if start > 0 and text[start].isalnum():
        before = text[start - 1]
        camel = text[start].isupper() and (before.islower() or before.isdigit())
        if before.isalnum() and not camel:
            return False
    if end < len(text) and text[end - 1].isalnum():
        after = text[end]
        camel = after.isupper() and not text[end - 1].isupper()
        if after.isalnum() and not camel:
            return False
    return True


def _is_identifier_use(text: str, start: int, end: int) -> bool:
    """Joined to another word (``_ . - / :`` then a letter or digit), camelCase, or quoted.

    So ``x_term``, ``core.term``, ``source:term``, ``termId`` and ``"term"`` match, while the
    same word in a sentence, before a full stop or a colon, does not.
    """
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""
    if before and before in QUOTES and before == after:
        return True
    if before and before in JOINERS and start >= 2 and text[start - 2].isalnum():
        return True
    if after and after in JOINERS and end + 1 < len(text) and text[end + 1].isalnum():
        return True
    # A whole token touching a letter or digit can only be at a camelCase change.
    return before.isalnum() or after.isalnum()


def _has_term(text: str, terms: Iterable[Term]) -> bool:
    for term in terms:
        for match in term.pattern.finditer(text):
            start, end = match.start(1), match.end(1)
            if not _is_whole_token(text, start, end):
                continue
            if not term.identifier_only or _is_identifier_use(text, start, end):
                return True
    return False


def _has_account_id(line: str) -> bool:
    if any(match.group() != ZERO_ACCOUNT for match in ACCOUNT_ID.finditer(line)):
        return True
    return any(f":{ZERO_ACCOUNT}:" not in match.group() for match in ARN.finditer(line))


def scan_text(
    shown: str, text: str, terms: tuple[Term, ...], generic: tuple[Rule, ...], accounts: bool
) -> Iterator[Finding]:
    for number, raw in enumerate(text.splitlines(), start=1):
        line = OPAQUE.sub(lambda match: " " * len(match.group()), raw)
        if not ALLOW_MARKER.search(line):
            for category, pattern in generic:
                if pattern.search(line):
                    yield Finding(shown, number, category)
            if accounts and _has_account_id(line):
                yield Finding(shown, number, "account-id")
        if _has_term(line, terms):
            yield Finding(shown, number, "private-term")


def scan_binary(shown: str, data: bytes, terms: tuple[Term, ...]) -> Iterator[Finding]:
    """Only private terms, in the printable runs a viewer or ``strings`` would show."""
    runs = [match.group().decode("ascii") for match in ASCII_RUN.finditer(data)]
    runs += [match.group().decode("utf-16-le") for match in UTF16_LE_RUN.finditer(data)]
    runs += [match.group().decode("utf-16-be") for match in UTF16_BE_RUN.finditer(data)]
    if any(_has_term(run, terms) for run in runs):
        yield Finding(shown, 0, "private-term")


def _is_allowed_lock_source(value: str) -> bool:
    if "://" not in value and ":" not in value:
        # A workspace link: a path inside the repository.
        return not value.startswith("/") and ".." not in value.split("/")
    parts = urlsplit(value)
    return parts.scheme == "https" and parts.hostname in ALLOWED_LOCK_HOSTS


def _lock_sources(document: object, keys: frozenset[str]) -> Iterator[str]:
    if isinstance(document, dict):
        for key, value in document.items():
            if key in keys and isinstance(value, str):
                yield value
            else:
                yield from _lock_sources(value, keys)
    elif isinstance(document, list):
        for item in document:
            yield from _lock_sources(item, keys)


def scan_lockfile_hosts(shown: str, text: str, npm: bool) -> Iterator[Finding]:
    """Every package source must be an allowed registry host or a link inside the repo."""
    try:
        if npm:
            line_pattern = NPM_RESOLVED_LINE
            sources = set(_lock_sources(json.loads(text), frozenset({"resolved"})))
        else:
            line_pattern = UV_URL_LINE
            sources = set(_lock_sources(tomllib.loads(text), UV_LOCK_URL_KEYS))
    except (json.JSONDecodeError, tomllib.TOMLDecodeError):
        yield Finding(shown, 0, "lockfile-unreadable")
        return
    rejected = {source for source in sources if not _is_allowed_lock_source(source)}
    located: set[str] = set()
    for number, line in enumerate(text.splitlines(), start=1):
        for match in line_pattern.finditer(line):
            if match.group(1) in rejected:
                located.add(match.group(1))
                yield Finding(shown, number, "lockfile-host")
    if rejected - located:
        yield Finding(shown, 0, "lockfile-host")


def _is_generic_exempt(path: str) -> bool:
    parts = path.split("/")
    return (
        path in SELF_EXEMPT
        or parts[-1] == ".gitignore"
        or parts[-1].startswith("LICENSE")
        or "LICENSES" in parts[:-1]
    )


def _shown_path(path: str, rules: Rules) -> str:
    if _has_term(path, rules.terms):
        return "sha256:" + hashlib.sha256(path.encode()).hexdigest()[:12]
    return path


def scan_path(path: str, rules: Rules) -> Iterator[Finding]:
    """The path itself is published too: a term there is reported without the path."""
    shown = _shown_path(path, rules)
    if shown != path:
        yield Finding(shown, 0, "private-term-in-path")
    if not _is_generic_exempt(path):
        for category, pattern in PATH_RULES:
            if pattern.search(path):
                yield Finding(shown, 0, f"{category}-in-path")


def scan_content(path: str, data: bytes, rules: Rules) -> Iterator[Finding]:
    if path in rules.terms_file_paths:
        return
    yield from scan_path(path, rules)
    shown = _shown_path(path, rules)
    if b"\0" in data:
        yield from scan_binary(shown, data, rules.terms)
        return
    text = data.decode("utf-8", errors="replace")
    name = posixpath.basename(path)
    if name in {NPM_LOCK, UV_LOCK}:
        yield from scan_lockfile_hosts(shown, text, npm=name == NPM_LOCK)
        yield from scan_text(shown, text, rules.terms, LOCKFILE_RULES, accounts=False)
    elif _is_generic_exempt(path):
        yield from scan_text(shown, text, rules.terms, (), accounts=False)
    else:
        yield from scan_text(shown, text, rules.terms, GENERIC_RULES, accounts=True)


def _symlink_problem(root: Path, link: Path) -> str | None:
    try:
        target = link.resolve(strict=True)
    except FileNotFoundError:
        target = link.resolve()  # Dangling: still reported if it points outside.
    except (OSError, RuntimeError):
        return "symlink-loop"
    return None if target.is_relative_to(root) else "symlink-escape"


def scan_tree(root: Path, rules: Rules) -> Iterator[Finding]:
    real_root = root.resolve()
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(directory)
        dirnames[:] = sorted(name for name in dirnames if name not in SKIPPED_DIRS)
        for name in [*dirnames, *filenames]:
            entry = base / name
            relative = entry.relative_to(root).as_posix()
            mode = entry.lstat().st_mode
            if stat.S_ISLNK(mode):
                yield from scan_path(relative, rules)
                problem = _symlink_problem(real_root, entry)
                if problem:
                    yield Finding(_shown_path(relative, rules), 0, problem)
            elif name in filenames and stat.S_ISREG(mode):
                yield from scan_content(relative, entry.read_bytes(), rules)


def _git(root: Path, *args: str) -> bytes:
    try:
        completed = subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ScanError(GIT_ERROR) from error
    return completed.stdout


def _symlink_escapes(path: str, target: str) -> bool:
    if target.startswith("/"):
        return True
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    return resolved == ".." or resolved.startswith("../")


def _changed_files(top: Path, parent: str, commit: str) -> Iterator[tuple[str, str, str]]:
    """``(mode, blob, path)`` of each file ``commit`` adds or modifies against ``parent``."""
    changed = _git(
        top, "diff", "--name-only", "--no-renames", "--diff-filter=AMT", "-z", parent, commit
    )
    paths = [path for path in changed.decode().split("\0") if path]
    if not paths:
        return
    listing = _git(top, "ls-tree", "-z", "--full-tree", commit, "--", *paths)
    for entry in listing.decode().split("\0"):
        meta, _, path = entry.partition("\t")
        if not path:
            continue
        mode, kind, blob = meta.split()
        if kind == "blob":
            yield mode, blob, path


def _commits(top: Path, base: str, head: str) -> list[tuple[str, str]]:
    """``(parent, commit)`` from oldest to newest; a root commit's parent is the empty tree."""
    empty_tree = _git(top, "hash-object", "-t", "tree", "/dev/null").decode().strip()
    base_is_tree = _git(top, "cat-file", "-t", base).decode().strip() == "tree"
    exclusion = [] if base_is_tree else ["--not", base]
    listing = _git(top, "rev-list", "--reverse", "--parents", head, *exclusion).decode()
    pairs: list[tuple[str, str]] = []
    for line in listing.splitlines():
        commit, *parents = line.split()
        pairs.append((parents[0] if parents else empty_tree, commit))
    return pairs


def scan_range(top: Path, revision_range: str, rules: Rules) -> Iterator[Finding]:
    """Scan what every commit in ``BASE..HEAD`` adds or modifies, as that commit has it."""
    base, separator, head = revision_range.partition("..")
    if not separator or not base or not head or head.startswith("."):
        raise ScanError("--changed expects BASE..HEAD")
    for parent, commit in _commits(top, base, head):
        for mode, blob, path in _changed_files(top, parent, commit):
            data = _git(top, "cat-file", "blob", blob)
            if mode == GIT_SYMLINK_MODE:
                yield from scan_path(path, rules)
                if _symlink_escapes(path, data.decode(errors="replace")):
                    yield Finding(_shown_path(path, rules), 0, "symlink-escape")
            else:
                yield from scan_content(path, data, rules)


def _terms_file_paths(root: Path, terms_file: Path | None) -> frozenset[str]:
    """The terms file lists every term; it is never scanned, wherever it lives."""
    if terms_file is None:
        return frozenset()
    resolved = terms_file.resolve()
    real_root = root.resolve()
    if not resolved.is_relative_to(real_root):
        return frozenset()
    return frozenset({resolved.relative_to(real_root).as_posix()})


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("root", nargs="?", default=".", type=Path, help="tree to scan")
    parser.add_argument("--terms-file", type=Path, help="private terms, one per line")
    parser.add_argument(
        "--changed", metavar="BASE..HEAD", help="only files changed in this range, at HEAD"
    )
    return parser.parse_args(argv)


def run(argv: Sequence[str]) -> int:
    args = _parse_args(argv)
    root: Path = args.root
    if not root.is_dir():
        raise ScanError(f"not a directory: {root}")
    terms = load_terms(args.terms_file) if args.terms_file else ()
    if args.changed:
        top = Path(_git(root, "rev-parse", "--show-toplevel").decode().strip())
        rules = Rules(terms, _terms_file_paths(top, args.terms_file))
        findings = scan_range(top, args.changed, rules)
    else:
        rules = Rules(terms, _terms_file_paths(root, args.terms_file))
        findings = scan_tree(root, rules)
    unique = sorted(set(findings))
    for finding in unique:
        print(finding.render())
    counts = Counter(finding.category for finding in unique)
    if not unique:
        print("publication-scan: clean", file=sys.stderr)
        return 0
    summary = ", ".join(f"{category}={count}" for category, count in sorted(counts.items()))
    print(f"publication-scan: {len(unique)} finding(s): {summary}", file=sys.stderr)
    return 1


def main() -> int:
    try:
        return run(sys.argv[1:])
    except ScanError as error:
        print(f"publication-scan: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
