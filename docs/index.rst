Periplo documentation
=====================

.. raw:: html

   <div class="periplo-hero">
     <img src="_static/logo.svg" alt="Periplo logo" />
   </div>
   <p align="center" style="margin:0.5rem 0 1.5rem;">
     <a href="https://github.com/MassiveDataScope/periplo/actions/workflows/ci.yml">
       <img src="https://img.shields.io/github/actions/workflow/status/MassiveDataScope/periplo/ci.yml?branch=master&label=ci" alt="CI" />
     </a>
     &nbsp;
     <a href="https://github.com/MassiveDataScope/periplo/actions/workflows/docs.yml">
       <img src="https://img.shields.io/github/actions/workflow/status/MassiveDataScope/periplo/docs.yml?branch=master&label=docs" alt="Docs" />
     </a>
     &nbsp;
     <a href="https://sonarcloud.io/summary/new_code?id=MassiveDataScope_periplo">
       <img src="https://sonarcloud.io/api/project_badges/measure?project=MassiveDataScope_periplo&metric=alert_status" alt="Quality Gate" />
     </a>
     &nbsp;
     <a href="https://app.codecov.io/gh/MassiveDataScope/periplo/tree/master">
       <img src="https://codecov.io/gh/MassiveDataScope/periplo/branch/master/graph/badge.svg" alt="Coverage" />
     </a>
     &nbsp;
     <a href="https://pypi.org/project/periplo/">
       <img src="https://img.shields.io/pypi/v/periplo" alt="PyPI" />
     </a>
     &nbsp;
     <img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue" alt="License: AGPL-3.0-only" />
   </p>

Periplo is an open-source console for Delta Lake data lakes, by MassiveDataScope.
It discovers the Delta tables under your S3 buckets, shows their schema, statistics
and history, runs read-only SQL over them, and follows the ETL deployments of a
Prefect orchestrator, all from one container image.

Source code: `github.com/MassiveDataScope/periplo <https://github.com/MassiveDataScope/periplo>`_.

.. toctree::
   :maxdepth: 2
   :caption: Overview

   overview

.. toctree::
   :maxdepth: 2
   :caption: Getting Started

   getting-started/quickstart

.. toctree::
   :maxdepth: 2
   :caption: Configuration

   configuration/environment
   configuration/sources

.. toctree::
   :maxdepth: 2
   :caption: Architecture

   architecture/overview
   architecture/extending

.. toctree::
   :maxdepth: 2
   :caption: ETL

   etl/console

.. toctree::
   :maxdepth: 2
   :caption: Deployment

   deployment/docker

.. toctree::
   :maxdepth: 2
   :caption: Project

   security
   contributing
   changelog

.. toctree::
   :maxdepth: 2
   :caption: Reference

   reference/api
