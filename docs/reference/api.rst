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

Storage credentials
-------------------

.. automodule:: periplo.credentials

Data planes
-----------

.. automodule:: periplo.data_plane

.. autofunction:: periplo.planes.build_data_plane

.. autofunction:: periplo.planes.metadata_cache

.. autoclass:: periplo.catalog.adapters.s3_lister.S3Storage

ETL orchestrators
-----------------

.. automodule:: periplo.etl.provider

.. autoclass:: periplo.etl.ports.Orchestrator
   :members:

.. autoclass:: periplo.etl.ports.RunResolver
   :members:
