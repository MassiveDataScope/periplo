"""The API is packaged from apps/api alone, so it carries its own copy of the root LICENSE.

A copy rather than a symlink, because not every checkout or archive keeps symlinks.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROOT_LICENSE = ROOT / "LICENSE"
API_LICENSE = ROOT / "apps" / "api" / "LICENSE"


def test_root_license_is_the_agpl() -> None:
    text = ROOT_LICENSE.read_text(encoding="utf-8")

    assert text.splitlines()[0].strip() == "GNU AFFERO GENERAL PUBLIC LICENSE"
    assert "Version 3, 19 November 2007" in text


def test_api_license_is_a_byte_identical_copy_of_the_root_one() -> None:
    assert API_LICENSE.read_bytes() == ROOT_LICENSE.read_bytes()
