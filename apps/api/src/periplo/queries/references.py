"""Which catalog tables a query reads.

Writes, DDL and file access are refused by the engine's own read-only options; this
module only answers what must be looked up in the catalog before anything is opened.
"""

from __future__ import annotations

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

from periplo.catalog.model import TableKey


class InvalidQuery(ValueError):
    """The SQL cannot be resolved against the catalog. The message is safe to show."""


def referenced_tables(sql: str) -> set[TableKey]:
    """Return the ``(database, table)`` pairs a single statement reads.

    Unquoted identifiers are folded to lower case, as the engine does, so that
    ``Landing_Shop.Orders`` finds the catalog entry ``landing_shop.orders``; a quoted
    identifier is taken exactly as written.

    Raises:
        InvalidQuery: If it is not exactly one statement, cannot be parsed, or names
            a table without its database.
    """
    try:
        statements = [statement for statement in sqlglot.parse(sql) if statement is not None]
    except SqlglotError as error:
        raise InvalidQuery("The SQL could not be parsed") from error
    if len(statements) != 1:
        raise InvalidQuery("Send exactly one statement")

    statement = statements[0]
    cte_names = {cte.alias_or_name for cte in statement.find_all(exp.CTE)}
    found: set[TableKey] = set()
    for table in statement.find_all(exp.Table):
        if not table.db and table.name in cte_names:
            continue
        if not table.db or table.catalog:
            raise InvalidQuery(f"Name tables as database.table: '{table.sql()}' is not")
        found.add((_identifier(table.args["db"]), _identifier(table.this)))
    return found


def _identifier(identifier: exp.Expression) -> str:
    name = str(identifier.name)
    quoted = isinstance(identifier, exp.Identifier) and identifier.quoted
    return name if quoted else name.lower()
