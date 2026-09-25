"""Sphinx configuration for the Periplo documentation."""

from __future__ import annotations

import importlib.metadata
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# The API sources come first, so autodoc documents this checkout even if another
# copy of the package is installed in the environment.
sys.path.insert(0, str(ROOT / "apps" / "api" / "src"))

project = "Periplo"
author = "MassiveDataScope"
copyright = f"{datetime.now().year}, {author}"
# One version for everything: the release tag, read back from the installed distribution.
# `make docs` runs inside the apps/api project, which installs it.
release = importlib.metadata.version("periplo")
version = release

extensions = [
    "myst_parser",
    "sphinx.ext.autodoc",
    "sphinx.ext.napoleon",
    "sphinx.ext.viewcode",
    "sphinx.ext.intersphinx",
    "sphinx_copybutton",
    "sphinx_design",
]

exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

html_theme = "furo"
html_static_path = ["_static"]
html_title = "Periplo docs"
html_logo = "_static/logo.svg"
html_favicon = "_static/logo.svg"
html_css_files = ["custom.css"]
html_theme_options = {
    "source_repository": "https://github.com/MassiveDataScope/periplo/",
    "source_branch": "master",
    "source_directory": "docs/",
}

autodoc_typehints = "description"
autodoc_typehints_format = "short"
autodoc_member_order = "bysource"
autodoc_default_options = {
    "members": True,
    "show-inheritance": True,
}
autodoc_preserve_defaults = True
napoleon_google_docstring = True
napoleon_numpy_docstring = False

# Generate ids for headings up to level 3 so Markdown pages can link to a
# specific section of another page ('other.md#some-heading'). A link to an id
# that does not exist is a warning, and the strict build turns it into a failure.
myst_heading_anchors = 3
myst_enable_extensions = ["colon_fence"]

source_suffix = {
    ".rst": "restructuredtext",
    ".md": "markdown",
}

intersphinx_mapping = {
    "python": ("https://docs.python.org/3", None),
}

# Type hints name third-party classes (loom, FastAPI, msgspec) that have no
# inventory to resolve against; they render as plain text instead of warning.
suppress_warnings = ["ref.python"]
