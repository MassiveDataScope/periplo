API reference
=============

The public extension surface of the ``periplo`` package: what a product built on
Periplo implements and passes to ``periplo.bootstrap.create_app``. See
:doc:`../architecture/extending` for how the pieces fit together.

Extensions
----------

.. automodule:: periplo.extensions

Identity and tenancy
--------------------

.. automodule:: periplo.tenancy

Authorization and audit
-----------------------

.. automodule:: periplo.access

ETL orchestrators
-----------------

.. automodule:: periplo.etl.provider

.. autoclass:: periplo.etl.ports.Orchestrator
   :members:
