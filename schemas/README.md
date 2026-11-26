# OECD schema files (not included)

The schema sweep test compares this validator with the official OECD schema. The schema files are published by the OECD and are not redistributed here.

To run the sweep:

1. Download the CARF XML Schema v1.5 package from the OECD CARF page.
2. Put `CARFXML_v1.5.xsd`, `oecdcarftypes_v5.0.xsd` and `isocarftypes_v1.1.xsd` in this folder.
3. Install `xmllint` (part of libxml2).
4. Run `npm test`.

Without these files the sweep is skipped and the other tests still run.
