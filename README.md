# carf-xml-validator

Checks OECD CARF XML files (the format behind DAC8 crypto reporting in the EU) and German BZSt DIP deliveries before you upload them. It runs offline, has zero dependencies and keeps customer data on your machine.

Every finding has a line number, a stable code, a sentence on what to fix in English or German, and a reference to the rule it comes from.

```
$ npx carf-xml-validator report.xml
report.xml: FAILED (1 error, 1 warning)
  error   line 91  DOCREFID_DUPLICATE  DocRefId "DE2026FIXTURE1-R" is used more than once (also on line 32).
          DocRefIds must be unique; a duplicate makes a later correction ambiguous.
          ref: CARF User Guide, Corrections
  warning line 76  AMOUNT_NEGATIVE  Amount is negative (-1200.00).
          CARF aggregates are reported as positive amounts; direction is expressed by which element they sit in.
          ref: CARF User Guide, Relevant Transactions
```

## Why it exists

The first DAC8 reports in Germany are due to the BZSt by 31 July 2027 (§ 9 Abs. 1 KStTG). The XSD tells you whether a file is well formed. It does not tell you about the rules the OECD User Guide states in prose, and that is where real filings fail: correction chains, DocRefId uniqueness, test data mixed with production data, a German tax ID with a wrong check digit.

Browsers have no XSD engine, so this validator is written by hand. The element structure is generated from the official schema as data; the prose rules are written out one by one.

## What it checks (93 finding codes)

- **XML and schema structure:** element order and counts, required attributes, enumerations, lengths, dates and decimals, all generated from `CARFXML_v1.5.xsd`, `oecdcarftypes_v5.0.xsd` and `isocarftypes_v1.1.xsd`.
- **Cross-field rules from the CARF User Guide (July 2025 update):** MessageTypeIndic against DocTypeIndic, correction references, nil reports with users, mixed transaction kinds, zero transaction counts, negative amounts.
- **German BZSt conventions:** MessageRefId and DocRefId prefixes, reporting period, the IdNr check digit, domestic-only cases.
- **The DIP envelope** (Digitaler Posteingang, the BZSt mass-data interface), when the file is a full delivery: `dip.xsd` version 2, application code CARF, exactly one consignment item, test and production flags, signature present.

## What it does not do

- It is not the BZSt's acceptance check. A file that passes here can still be rejected there.
- It does not check that the numbers are right, only that the file is consistent.
- It does not sign or send anything.

## Use it

Command line (Node 18 or newer):

```
npx carf-xml-validator report.xml
npx carf-xml-validator --de report.xml        # findings in German
npx carf-xml-validator --json report.xml      # machine-readable
```

Exit code 0 when no file has an error, 1 when any file has an error, 2 for bad usage. Warnings never fail the run, so it fits in CI.

As a library:

```js
import { validateCarf } from "carf-xml-validator";

const result = validateCarf(xmlString);
result.ok;          // false when any finding is an error
result.findings;    // [{ severity, line, code, message: { en, de }, hint, ref }]
result.summary;     // counts, reporting period, envelope details
```

In the browser, with nothing to install: [stablewerk.com/en/carf-validator](https://stablewerk.com/en/carf-validator).

## Tests

```
npm test
```

89 tests run on every change. One more test sweeps every rule against the official OECD schema with `xmllint`; it runs when the schema files are in `schemas/` (see `schemas/README.md`).

## Who maintains it

[Stablewerk](https://stablewerk.com) builds the DAC8 workflow and DATEV bookkeeping for German crypto-asset service providers. This validator is the same code that runs on our site.

Found a file that passes here but fails at the BZSt, or the other way round? Open an issue with the finding code and, if you can, a redacted sample.

## Licence

MIT. See [LICENSE](LICENSE).
