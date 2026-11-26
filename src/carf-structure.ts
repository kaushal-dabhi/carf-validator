// Structure and values of a CARF message, checked against the OECD schema's
// own model (carf-schema.ts, generated from the XSD by a generator script).
//
// The validator in carf.ts carries the rules the User Guide states in prose
// and the German filing conventions. This module is the other half: the
// plain schema. Which elements a type may hold, in what order, how many
// times; which attributes are required; what each text value may be. A file
// that breaks any of it fails the BZSt's schema check before a human rule
// is even looked at, so it is an error here.
//
// What it does not do: unknown attributes are not flagged, because the
// parser folds namespace declarations into the attribute map and cannot tell
// them from real attributes. Facet checks cover what the CARF schema uses
// (enumeration, length, decimal and integer digits, date, dateTime, boolean).

import type { Finding, XNode } from "./carf.ts";
import { CARF_SCHEMA, type SchemaLeaf, type SchemaParticle } from "./carf-schema.ts";
import { SCHEMA_COUNTRIES, SCHEMA_CURRENCIES } from "./carf-iso.ts";

type Bi = { de: string; en: string };

// The namespace a node's own prefix is bound to, looking up through the
// ancestors: a filer may declare it on an enclosing element. The parser keeps
// a declaration xmlns:p="..." under the attribute key "p" and a default
// declaration under "xmlns".
export function resolvedNamespace(node: XNode): string | null {
  const prefix = node.raw.includes(":") ? node.raw.split(":")[0] : null;
  for (let n: XNode | undefined = node; n; n = n.parent) {
    const v = prefix ? n.attrs[prefix] : n.attrs["xmlns"];
    if (v !== undefined) return v;
  }
  return null;
}

// xs:date, with the optional time zone the type allows, and a day that
// exists in that month (31.02 and 2027-02-30 are not dates).
export function isRealDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function isRealDateTime(v: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(v);
  if (!m) return false;
  return isRealDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60;
}

const bi = (de: string, en: string): Bi => ({ de, en });

// Why a text value is not allowed by a leaf type, or null when it is.
function leafProblem(leaf: SchemaLeaf, raw: string): Bi | null {
  const v = raw.trim();
  if (leaf.set) {
    const set = leaf.set === "countries" ? SCHEMA_COUNTRIES : SCHEMA_CURRENCIES;
    if (!set.has(v)) {
      return bi(
        `"${v}" steht nicht in der ${leaf.set === "countries" ? "Länderliste" : "Währungsliste"} des Schemas`,
        `"${v}" is not in the schema's list of ${leaf.set}`,
      );
    }
  }
  if (leaf.enum && !leaf.enum.includes(v)) {
    const shown = leaf.enum.length <= 12 ? leaf.enum.join(", ") : `${leaf.enum.slice(0, 12).join(", ")} ...`;
    return bi(`"${v}" ist kein zulässiger Wert (erlaubt: ${shown})`, `"${v}" is not an allowed value (allowed: ${shown})`);
  }
  switch (leaf.b) {
    case "integer":
      if (!/^[+-]?\d+$/.test(v)) return bi(`"${v}" ist keine ganze Zahl`, `"${v}" is not a whole number`);
      break;
    case "decimal": {
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v)) return bi(`"${v}" ist keine Dezimalzahl`, `"${v}" is not a decimal number`);
      const frac = (v.split(".")[1] ?? "").length;
      if (leaf.fractionDigits !== undefined && frac > leaf.fractionDigits) {
        return bi(`"${v}" hat mehr als ${leaf.fractionDigits} Nachkommastellen`, `"${v}" has more than ${leaf.fractionDigits} decimal places`);
      }
      break;
    }
    case "date":
      if (!isRealDate(v)) return bi(`"${v}" ist kein gültiges Datum (JJJJ-MM-TT)`, `"${v}" is not a valid date (YYYY-MM-DD)`);
      break;
    case "dateTime":
      if (!isRealDateTime(v)) return bi(`"${v}" ist keine gültige Zeitangabe (JJJJ-MM-TTThh:mm:ss)`, `"${v}" is not a valid date and time (YYYY-MM-DDThh:mm:ss)`);
      break;
    case "boolean":
      if (!["true", "false", "1", "0"].includes(v)) return bi(`"${v}" ist kein Wahrheitswert (true oder false)`, `"${v}" is not a boolean (true or false)`);
      break;
    default:
      break;
  }
  const len = [...v].length;
  if (leaf.length !== undefined && len !== leaf.length) {
    return bi(`"${v}" muss genau ${leaf.length} Zeichen haben`, `"${v}" must be exactly ${leaf.length} characters`);
  }
  if (leaf.minLength !== undefined && len < leaf.minLength) {
    return bi(
      leaf.minLength === 1 ? "der Wert ist leer, mindestens ein Zeichen ist verlangt" : `der Wert hat weniger als ${leaf.minLength} Zeichen`,
      leaf.minLength === 1 ? "the value is empty, at least one character is required" : `the value is shorter than ${leaf.minLength} characters`,
    );
  }
  if (leaf.maxLength !== undefined && len > leaf.maxLength) {
    return bi(`der Wert hat ${len} Zeichen, höchstens ${leaf.maxLength} sind erlaubt`, `the value has ${len} characters, at most ${leaf.maxLength} are allowed`);
  }
  return null;
}

// --- content model matching ---------------------------------------------

type Track = { pos: number; expected: Set<string> };

// Every position in `kids` a particle can end at, starting from `pos`. The
// furthest point any attempt reached is kept in `tr`, with the names that
// would have been accepted there: that is what an error message needs.
function ends(p: SchemaParticle, kids: XNode[], pos: number, tr: Track): Set<number> {
  const note = (at: number, names: string[]) => {
    if (at > tr.pos) {
      tr.pos = at;
      tr.expected = new Set(names);
    } else if (at === tr.pos) names.forEach((n) => tr.expected.add(n));
  };
  if (p.t === "el") {
    let k = 0;
    while (pos + k < kids.length && kids[pos + k].name === p.n && (p.max === null || k < p.max)) k++;
    const out = new Set<number>();
    for (let c = p.min; c <= k; c++) out.add(pos + c);
    if (k < p.min || p.max === null || k < p.max) note(pos + k, [p.n]);
    return out;
  }
  const once = (from: number): Set<number> => {
    if (p.t === "seq") {
      let cur = new Set<number>([from]);
      for (const it of p.items) {
        const nx = new Set<number>();
        for (const c of cur) for (const e of ends(it, kids, c, tr)) nx.add(e);
        cur = nx;
        if (!cur.size) break;
      }
      return cur;
    }
    const nx = new Set<number>();
    for (const it of p.items) for (const e of ends(it, kids, from, tr)) nx.add(e);
    return nx;
  };
  const result = new Set<number>();
  if (p.min === 0) result.add(pos);
  let cur = new Set<number>([pos]);
  const limit = p.max === null ? kids.length + 1 : p.max;
  for (let r = 1; r <= limit; r++) {
    const nx = new Set<number>();
    for (const c of cur) for (const e of once(c)) nx.add(e);
    if (!nx.size) break;
    const progressed = [...nx].some((e) => !cur.has(e));
    if (r >= p.min) nx.forEach((e) => result.add(e));
    if (!progressed) break;
    cur = nx;
  }
  return result;
}

type Kid = { ty: string; ns: "carf" | "stf" | "iso" };
const kidTypes = new Map<string, Map<string, Kid>>();
function typesOfChildren(tid: string): Map<string, Kid> {
  let m = kidTypes.get(tid);
  if (m) return m;
  m = new Map();
  const walk = (p: SchemaParticle | undefined) => {
    if (!p) return;
    if (p.t === "el") m!.set(p.n, { ty: p.ty, ns: p.ns });
    else p.items.forEach(walk);
  };
  walk(CARF_SCHEMA.types[tid]?.p);
  kidTypes.set(tid, m);
  return m;
}

// --- the walk -----------------------------------------------------------

export function checkStructure(root: XNode, add: (f: Finding) => void): void {
  const rootType = CARF_SCHEMA.roots[root.name];
  if (!rootType) return;

  const walk = (node: XNode, tid: string): void => {
    const spec = CARF_SCHEMA.types[tid];
    if (!spec) return;

    for (const [name, a] of Object.entries(spec.attrs ?? {})) {
      const v = node.attrs[name];
      if (v === undefined) {
        if (a.req) {
          add({
            severity: "error",
            line: node.line,
            code: "SCHEMA_ATTR_MISSING",
            message: bi(`<${node.raw}> hat nicht das Pflichtattribut ${name}.`, `<${node.raw}> is missing the required attribute ${name}.`),
            ref: "CARFXML_v1.5.xsd",
          });
        }
        continue;
      }
      const why = leafProblem(CARF_SCHEMA.leaves[a.t], v);
      if (why) {
        add({
          severity: "error",
          line: node.line,
          code: "SCHEMA_ATTR_VALUE",
          message: bi(`Attribut ${name} an <${node.raw}>: ${why.de}.`, `Attribute ${name} on <${node.raw}>: ${why.en}.`),
          ref: "CARFXML_v1.5.xsd",
        });
      }
    }

    if (spec.leaf) {
      if (node.children.length) {
        const c = node.children[0];
        add({
          severity: "error",
          line: c.line,
          code: "SCHEMA_UNEXPECTED",
          message: bi(`<${c.raw}> ist in <${node.raw}> nicht erlaubt, das Element enthält nur Text.`, `<${c.raw}> is not allowed inside <${node.raw}>, which holds text only.`),
          ref: "CARFXML_v1.5.xsd",
        });
      }
      const why = leafProblem(CARF_SCHEMA.leaves[spec.leaf], node.text);
      if (why) {
        add({
          severity: "error",
          line: node.line,
          code: "SCHEMA_VALUE",
          message: bi(`<${node.raw}>: ${why.de}.`, `<${node.raw}>: ${why.en}.`),
          ref: "CARFXML_v1.5.xsd",
        });
      }
      return;
    }

    const kids = node.children;
    const tr: Track = { pos: -1, expected: new Set() };
    const full = spec.p ? ends(spec.p, kids, 0, tr).has(kids.length) : kids.length === 0;
    if (!full) {
      const want = [...tr.expected];
      if (spec.p && tr.pos >= 0 && tr.pos < kids.length) {
        const c = kids[tr.pos];
        add({
          severity: "error",
          line: c.line,
          code: "SCHEMA_UNEXPECTED",
          message: bi(
            `<${c.raw}> steht in <${node.raw}> an einer Stelle, an der das Schema es nicht zulässt${want.length ? `; erwartet wird ${want.join(" oder ")}` : ""}.`,
            `<${c.raw}> is not allowed at this point in <${node.raw}>${want.length ? `; expected ${want.join(" or ")}` : ""}.`,
          ),
          hint: bi(
            "Das Schema schreibt Reihenfolge und Anzahl der Kindelemente vor; das BZSt weist eine Abweichung ab.",
            "The schema fixes the order and number of child elements; the BZSt rejects a deviation.",
          ),
          ref: "CARFXML_v1.5.xsd",
        });
      } else if (!spec.p && kids.length) {
        const c = kids[0];
        add({
          severity: "error",
          line: c.line,
          code: "SCHEMA_UNEXPECTED",
          message: bi(`<${c.raw}> ist in <${node.raw}> nicht erlaubt.`, `<${c.raw}> is not allowed inside <${node.raw}>.`),
          ref: "CARFXML_v1.5.xsd",
        });
      } else {
        add({
          severity: "error",
          line: node.line,
          code: "SCHEMA_MISSING",
          message: bi(
            `In <${node.raw}> fehlt ein Pflichtelement${want.length ? `: ${want.join(" oder ")}` : ""}.`,
            `<${node.raw}> is missing a required element${want.length ? `: ${want.join(" or ")}` : ""}.`,
          ),
          hint: bi("Das Schema verlangt dieses Element; ohne es besteht die Datei die Schemaprüfung nicht.", "The schema requires this element; without it the file fails the schema check."),
          ref: "CARFXML_v1.5.xsd",
        });
      }
    }
    const kt = typesOfChildren(tid);
    for (const c of kids) {
      const t = kt.get(c.name);
      if (!t) continue;
      // Elements are namespace-qualified: DocTypeIndic lives in the stf
      // namespace, MessageSpec in the carf one. In the wrong one the schema
      // finds no such element, however the name reads.
      const got = resolvedNamespace(c);
      const want = CARF_SCHEMA.namespaces[t.ns];
      if (got !== want) {
        add({
          severity: "error",
          line: c.line,
          code: "SCHEMA_NAMESPACE",
          message: bi(
            `<${c.raw}> liegt im Namensraum ${got === null ? "(keiner)" : `"${got}"`}, das Schema verlangt ${want}.`,
            `<${c.raw}> is in namespace ${got === null ? "(none)" : `"${got}"`}, the schema requires ${want}.`,
          ),
          hint: bi(
            `Binden Sie das Präfix dieses Elements an ${want}. Die Kindelemente von DocSpec gehören zum Namensraum stf (urn:oecd:ties:carfstf:v5), nicht zu carf.`,
            `Bind this element's prefix to ${want}. The children of DocSpec belong to the stf namespace (urn:oecd:ties:carfstf:v5), not carf.`,
          ),
          ref: "CARFXML_v1.5.xsd, elementFormDefault qualified",
        });
      }
      walk(c, t.ty);
    }
  };

  walk(root, rootType);
}
