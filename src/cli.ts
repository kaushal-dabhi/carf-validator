#!/usr/bin/env node
// carf-validate: check one or more CARF / DAC8 XML files from the command line.
// Exit code 0 when every file has no errors, 1 when any file has an error,
// 2 on bad usage or an unreadable file. Warnings never fail the run.

import { readFileSync } from "node:fs";
import { bySeverityThenLine, say, validateCarf } from "./carf.ts";

const args = process.argv.slice(2);
const lang: "de" | "en" = args.includes("--de") ? "de" : "en";
const json = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0 || args.includes("--help")) {
  console.log(`Usage: carf-validate [--de] [--json] <file.xml> [more files]

Checks CARF XML (OECD schema v1.5) and BZSt DIP deliveries offline.
Nothing leaves your machine.

  --de    findings in German
  --json  machine-readable output`);
  process.exit(files.length === 0 && !args.includes("--help") ? 2 : 0);
}

let failed = false;
const out: unknown[] = [];

for (const file of files) {
  let src: string;
  try {
    src = readFileSync(file, "utf-8");
  } catch (e) {
    console.error(`${file}: cannot read (${(e as Error).message})`);
    process.exit(2);
  }
  const result = validateCarf(src);
  if (!result.ok) failed = true;

  if (json) {
    out.push({ file, ...result });
    continue;
  }
  const findings = [...result.findings].sort(bySeverityThenLine);
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  console.log(`${file}: ${result.ok ? "OK" : "FAILED"} (${n(errors, "error")}, ${n(warnings, "warning")})`);
  for (const f of findings) {
    console.log(`  ${f.severity.padEnd(7)} line ${f.line}  ${f.code}  ${say(f.message, lang)}`);
    const hint = say(f.hint, lang);
    if (hint) console.log(`          ${hint}`);
    if (f.ref) console.log(`          ref: ${f.ref}`);
  }
}

if (json) console.log(JSON.stringify(files.length === 1 ? out[0] : out, null, 2));
process.exit(failed ? 1 : 0);
