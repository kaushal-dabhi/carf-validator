// CARF XML validator, per the OECD Crypto-Asset Reporting Framework XML
// Schema User Guide (July 2025 technical update, schema v1.5).
//
// Why this is hand-written rather than an XSD validator: browsers have no
// XSD engine, and shipping one would mean the file leaves the user's machine
// or a megabyte of WASM arrives on theirs. Everything here runs client-side
// on a string, which is the point - a CASP's reportable customer data never
// leaves their browser. It also lets every finding carry a line number and a
// plain sentence about what to do, which an XSD error never does.
//
// Scope, stated honestly: this checks structure, enumerations, the
// cross-field rules the User Guide states in prose (which is where real
// filings actually fail), and German BZSt filing conventions. Since
// 14.10.2026 it also checks the DIP envelope (Digitaler Posteingang, the
// BZSt mass-data interface) when the file is a full delivery rather than a
// bare CARF payload: dip.xsd schema version 2 (BZSt download, 20.11.2024),
// the Datensatzbeschreibung of 17.11.2025 (version 2.0 only, application
// code CARF, exactly one consignmentItem), and the pre-checks listed in the
// Kommunikationshandbuch DIP-Standard 2.4 (May 2026). It is not a
// substitute for the BZSt's own acceptance check, and the page says so.

import { SCHEMA_COUNTRIES, SCHEMA_CURRENCIES } from "./carf-iso.ts";
import { checkStructure, isRealDate, resolvedNamespace } from "./carf-structure.ts";

export type Severity = "error" | "warning" | "info";

export type Bi = { de: string; en: string };

export type Finding = {
  severity: Severity;
  line: number;
  code: string;
  message: Bi;
  hint?: Bi;
  ref?: string; // where in the User Guide / German law this comes from
};

// Resolve a finding into one language. The German side is not a courtesy
// translation: this tool is aimed at German reporting entities, and an
// error message they have to translate before acting on it is a worse
// error message.
export function say(b: Bi | undefined, lang: "de" | "en"): string {
  return b ? b[lang] : "";
}

export type ValidationResult = {
  ok: boolean;
  findings: Finding[];
  summary: {
    rcaspCount: number;
    userCount: number;
    transactionElements: number;
    messageTypeIndic: string | null;
    reportingPeriod: string | null;
    docTypeIndics: string[];
    isTestData: boolean;
    // null for a bare CARF payload; filled when the file is a DIP delivery
    envelope: null | {
      version: string | null;
      environment: string | null;
      application: string | null;
      identityProvider: string | null;
      transferticketId: string | null;
      referenceId: string | null;
      // true when the file carries the customer's enveloped signature
      signed: boolean;
    };
  };
};

// --- minimal XML scanner -----------------------------------------------
// Produces a tree with line numbers. Deliberately small: we validate a
// known schema, so we need tags, attributes, text and positions, nothing
// more. Namespace prefixes are stripped for matching, since filers vary
// between carf:, crf: and no prefix at all and the schema meaning is the same.

export type XNode = {
  name: string;
  raw: string; // name including prefix, for messages
  attrs: Record<string, string>;
  text: string;
  children: XNode[];
  line: number;
  parent?: XNode;
};

const SELF_CLOSING = /\/>$/;

export function parseXml(src: string): { root: XNode | null; error: Finding | null } {
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  const stack: XNode[] = [];
  let root: XNode | null = null;
  const tagRe = /<(\/)?([A-Za-z_][\w.\-:]*)((?:\s+[\w.\-:]+\s*=\s*"[^"]*")*)\s*(\/)?>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;

  while ((m = tagRe.exec(src))) {
    const full = m[0];
    if (full.startsWith("<?") || full.startsWith("<!--") || full.startsWith("<![CDATA[")) {
      lastIndex = tagRe.lastIndex;
      continue;
    }
    const isClose = m[1] === "/";
    const rawName = m[2];
    const name = rawName.includes(":") ? rawName.split(":").pop()! : rawName;
    const attrStr = m[3] || "";
    const selfClose = m[4] === "/" || SELF_CLOSING.test(full);

    // text between previous tag and this one belongs to the open element
    if (stack.length) {
      const between = src.slice(lastIndex, m.index).trim();
      if (between) stack[stack.length - 1].text += between;
    }
    lastIndex = tagRe.lastIndex;

    if (isClose) {
      const open = stack.pop();
      if (!open) {
        return {
          root: null,
          error: {
            severity: "error",
            line: lineOf(m.index),
            code: "XML_UNBALANCED",
            message: { de: `Schließendes Tag </${rawName}> hat kein öffnendes Gegenstück.`, en: `Closing tag </${rawName}> has no matching opening tag.` },
          },
        };
      }
      if (open.name !== name) {
        return {
          root: null,
          error: {
            severity: "error",
            line: lineOf(m.index),
            code: "XML_MISMATCH",
            message: { de: `Schließendes Tag </${rawName}> passt nicht zum offenen Element <${open.raw}> aus Zeile ${open.line}.`, en: `Closing tag </${rawName}> does not match open element <${open.raw}> from line ${open.line}.` },
          },
        };
      }
      continue;
    }

    const attrs: Record<string, string> = {};
    const attrRe = /([\w.\-:]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrStr))) {
      const key = a[1].includes(":") ? a[1].split(":").pop()! : a[1];
      attrs[key] = a[2];
    }

    const node: XNode = {
      name,
      raw: rawName,
      attrs,
      text: "",
      children: [],
      line: lineOf(m.index),
    };
    if (stack.length) {
      node.parent = stack[stack.length - 1];
      stack[stack.length - 1].children.push(node);
    } else if (!root) {
      root = node;
    }
    if (!selfClose) stack.push(node);
  }

  if (stack.length) {
    const open = stack[stack.length - 1];
    return {
      root,
      error: {
        severity: "error",
        line: open.line,
        code: "XML_UNCLOSED",
        message: { de: `Element <${open.raw}> aus Zeile ${open.line} wird nie geschlossen.`, en: `Element <${open.raw}> opened on line ${open.line} is never closed.` },
      },
    };
  }
  if (!root) {
    return {
      root: null,
      error: {
        severity: "error",
        line: 1,
        code: "XML_EMPTY",
        message: { de: "Keine XML-Elemente gefunden. Ist das eine XML-Datei?", en: "No XML elements found. Is this an XML file?" },
      },
    };
  }
  return { root, error: null };
}

// --- helpers ------------------------------------------------------------

export function find(node: XNode, path: string[]): XNode | null {
  let cur: XNode | null = node;
  for (const p of path) {
    if (!cur) return null;
    cur = cur.children.find((c) => c.name === p) || null;
  }
  return cur;
}

export function findAll(node: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

// --- reference data -----------------------------------------------------

// ISO 3166-1 alpha-2, EU/EEA plus the jurisdictions that have committed to
// CARF exchanges. A code outside this list is a warning, not an error: the
// list moves, and a filer is not wrong merely because our copy is stale.
const KNOWN_COUNTRIES = new Set(
  ("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO " +
    "GB CH US CA AU NZ JP SG KR BR ZA MX CL IL AE IN ID TR UA RS ME MK AL MD GE AM AZ KZ " +
    "AR CO CR PA PE UY BB BM BS KY GG IM JE MC SM AD VG AI AG AW BZ CW DM GD MS KN LC VC SX TC VU WS SC MU MY TH HK MO CN")
    .split(/\s+/)
);

// The namespace the schema's root element lives in. A message in any other
// namespace is not a CARF message to the BZSt: the schema check finds no
// declaration for its root.
const CARF_NAMESPACE = "urn:oecd:ties:carf:v1";

// Check digit of the German Steuer-Identifikationsnummer: ISO 7064 MOD 11,10
// over the first ten digits (same algorithm as the Stablewerk engine).
function idnrCheckDigitOk(digits: string): boolean {
  let product = 10;
  for (const ch of digits.slice(0, 10)) {
    let s = (Number(ch) + product) % 10;
    if (s === 0) s = 10;
    product = (s * 2) % 11;
  }
  const check = 11 - product === 10 ? 0 : 11 - product;
  return check === Number(digits[10]);
}

const MESSAGE_TYPE_INDIC = new Set(["CARF701", "CARF702", "CARF703"]);
const DOC_TYPE_INDIC = new Set([
  "OECD0", "OECD1", "OECD2", "OECD3",
  "OECD10", "OECD11", "OECD12", "OECD13",
]);
const TEST_DOC_TYPES = new Set(["OECD10", "OECD11", "OECD12", "OECD13"]);
const NEXUS = new Set([
  "CARF901", "CARF902", "CARF903", "CARF904", "CARF905", "CARF906", "CARF907",
]);
// Inbound and outbound transfers use different enumerations (CARFXML_v1.5.xsd:
// TransferType_EnumType CARF501 to CARF509, TransferOutType_EnumType CARF601
// to CARF606). Until 19.10.2026 this validator applied the outbound list to
// both and would have rejected every valid inbound transfer.
const TRANSFER_IN_TYPE = new Set(["CARF501", "CARF502", "CARF503", "CARF504", "CARF505", "CARF506", "CARF507", "CARF508", "CARF509"]);
const TRANSFER_OUT_TYPE = new Set(["CARF601", "CARF602", "CARF603", "CARF604", "CARF605", "CARF606"]);
const EXCHANGE_TYPE = new Set(["CARF401", "CARF402", "CARF403", "CARF404"]);
const ALT_VALUATION = new Set(["CARF1001", "CARF1002", "CARF1003", "CARF1004"]);
const CTRLG_PERSON_TYPE = new Set(Array.from({ length: 13 }, (_, i) => `CARF8${String(i + 1).padStart(2, "0")}`));
// The one-kind-per-element rule: RelevantTransactions_Type holds CryptoAsset
// and then an xs:choice over the block kinds, so an element may carry one
// kind only (repeated if needed). Verified against the schema with xmllint.
const TX_BLOCKS = new Set(["CryptoToCryptoIn", "CryptoToCryptoOut", "CryptoFiatIn", "CryptoFiatOut", "CryptoTransferIn", "CryptoTransferOut", "TransferWallet", "RRPT"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

// DIP envelope, dip.xsd schema version 2 (targetNamespace below) and the
// Datensatzbeschreibung of 17.11.2025. The handbook's example delivery
// (KHB DIP-Standard 2.4, section 5.3) confirms the element order used here:
// application sits in the header, after consignment, not in the body.
const DIP_NS = "http://itzbund.de/ozg/bzst/post/dip/v2/";
const DIP_ENVIRONMENTS = new Set(["TEST", "PROD"]);
const DIP_PROVIDERS = new Set(["BZST-CERT", "ELSTER"]);
const DIP_REF = "BZSt dip.xsd v2 / Datensatzbeschreibung 17.11.2025";
const KHB_REF = "KHB DIP-Standard 2.4";

// --- the DIP envelope ---------------------------------------------------

// The parser strips prefixes from attribute names too, so xmlns:dip="..."
// lands under the key "dip" and a bare xmlns="..." under "xmlns". This
// reads back whichever declaration governs the element's own prefix.
function namespaceOf(node: XNode): string | null {
  const prefix = node.raw.includes(":") ? node.raw.split(":")[0] : null;
  const v = prefix ? node.attrs[prefix] : node.attrs["xmlns"];
  return v === undefined ? null : v;
}

export type SeqRule = { name: string; min: number; max: number };

// Checks a node's children against an xs:sequence: unknown elements,
// missing required ones, too many of a non-repeatable one, wrong order.
// The BZSt rejects all four with E0600 (schema validation of the header).
export function checkSequence(node: XNode, rules: SeqRule[], add: (f: Finding) => void): void {
  const allowed = rules.map((r) => r.name);
  const seen: string[] = [];
  for (const c of node.children) {
    if (!allowed.includes(c.name)) {
      add({
        severity: "error",
        line: c.line,
        code: "DIP_UNKNOWN_ELEMENT",
        message: { de: `<${c.raw}> ist in <${node.raw}> nicht vorgesehen.`, en: `<${c.raw}> is not allowed inside <${node.raw}>.` },
        hint: { de: `Zulässig sind: ${allowed.join(", ")}. Das Schema des Umschlags ist geschlossen; ein unbekanntes Element lässt die Lieferung an der Schemaprüfung scheitern.`, en: `Allowed: ${allowed.join(", ")}. The envelope schema is closed; an unknown element fails the delivery at schema validation.` },
        ref: `${DIP_REF}, E0600`,
      });
      continue;
    }
    seen.push(c.name);
  }
  for (const r of rules) {
    const n = seen.filter((x) => x === r.name).length;
    if (n < r.min) {
      add({
        severity: "error",
        line: node.line,
        code: "DIP_MISSING",
        message: { de: `In <${node.raw}> fehlt das Pflichtelement <${r.name}>.`, en: `<${node.raw}> is missing the required element <${r.name}>.` },
        ref: `${DIP_REF}, E0600`,
      });
    } else if (n > r.max) {
      add({
        severity: "error",
        line: node.line,
        code: "DIP_TOO_MANY",
        message: { de: `<${r.name}> kommt in <${node.raw}> ${n}-mal vor, zulässig ist höchstens ${r.max}.`, en: `<${r.name}> appears ${n} times in <${node.raw}>, at most ${r.max} allowed.` },
        ref: `${DIP_REF}, E0600`,
      });
    }
  }
  // order: the sequence of distinct known names must be a subsequence of the rules
  let pos = 0;
  for (const name of seen) {
    const idx = allowed.indexOf(name);
    if (idx < pos) {
      add({
        severity: "error",
        line: node.line,
        code: "DIP_ORDER",
        message: { de: `Die Kindelemente von <${node.raw}> stehen in falscher Reihenfolge; erwartet wird ${allowed.join(", ")}.`, en: `The children of <${node.raw}> are in the wrong order; expected ${allowed.join(", ")}.` },
        hint: { de: "Ein xs:sequence erzwingt die Reihenfolge. Die Lieferung scheitert sonst an der Schemaprüfung des Umschlags.", en: "An xs:sequence enforces the order. Otherwise the delivery fails the envelope's schema validation." },
        ref: `${DIP_REF}, E0600`,
      });
      break;
    }
    pos = idx;
  }
}

export function checkLength(node: XNode | null, min: number, max: number, add: (f: Finding) => void): void {
  if (!node) return;
  const v = node.text.trim();
  if (v.length < min || v.length > max) {
    add({
      severity: "error",
      line: node.line,
      code: "DIP_LENGTH",
      message: { de: `<${node.raw}> hat ${v.length} Zeichen, zulässig sind ${min} bis ${max}.`, en: `<${node.raw}> is ${v.length} characters, ${min} to ${max} allowed.` },
      ref: DIP_REF,
    });
  }
}

// The XML declaration is a DIP pre-check, not an XML requirement: the BZSt
// rejects a delivery without one (E0603) or with an encoding not named
// exactly UTF-8 (E0604; "UTF8" is listed as invalid). For a bare CARF
// payload the same findings are warnings, since the file is not the
// delivery yet.
export function checkDeclaration(src: string, isDelivery: boolean, add: (f: Finding) => void): void {
  const sev: Severity = isDelivery ? "error" : "warning";
  const m = /^\uFEFF?\s*<\?xml\b([^?]*)\?>/.exec(src);
  if (!m) {
    add({
      severity: sev,
      line: 1,
      code: "DIP_NO_DECLARATION",
      message: { de: "Die Datei beginnt nicht mit einer XML-Deklaration.", en: "The file does not start with an XML declaration." },
      hint: { de: 'Erwartet wird <?xml version="1.0" encoding="UTF-8"?> in der ersten Zeile. Das BZSt weist eine Lieferung ohne Deklaration mit E0603 ab.', en: 'Expected <?xml version="1.0" encoding="UTF-8"?> on the first line. The BZSt rejects a delivery without a declaration with E0603.' },
      ref: `${KHB_REF}, E0603`,
    });
    return;
  }
  const enc = /encoding\s*=\s*"([^"]*)"/.exec(m[1]);
  if (!enc || enc[1] !== "UTF-8") {
    add({
      severity: sev,
      line: 1,
      code: "DIP_ENCODING",
      message: enc
        ? { de: `Die XML-Deklaration nennt das Encoding "${enc[1]}", verlangt ist genau "UTF-8".`, en: `The XML declaration names encoding "${enc[1]}"; exactly "UTF-8" is required.` }
        : { de: "Die XML-Deklaration nennt kein Encoding; verlangt ist encoding=\"UTF-8\".", en: 'The XML declaration names no encoding; encoding="UTF-8" is required.' },
      hint: { de: "Das Kommunikationshandbuch nennt Schreibweisen wie UTF8 ausdrücklich als ungültig (E0604).", en: "The communication handbook lists spellings such as UTF8 as invalid (E0604)." },
      ref: `${KHB_REF}, E0604`,
    });
  }
}

// Validates the envelope and returns the CARF payload root inside it, or
// null when there is nothing a CARF check could run on.
function checkDip(root: XNode, add: (f: Finding) => void, summary: ValidationResult["summary"]): XNode | null {
  const env: NonNullable<ValidationResult["summary"]["envelope"]> = {
    version: root.attrs["version"] ?? null,
    environment: null,
    application: null,
    identityProvider: null,
    transferticketId: null,
    referenceId: null,
    signed: false,
  };
  summary.envelope = env;

  const ns = namespaceOf(root);
  if (ns !== DIP_NS) {
    add({
      severity: "error",
      line: root.line,
      code: "DIP_NAMESPACE",
      message: ns
        ? { de: `Der Umschlag deklariert den Namensraum "${ns}", erwartet wird "${DIP_NS}".`, en: `The envelope declares namespace "${ns}", expected "${DIP_NS}".` }
        : { de: `Der Umschlag <${root.raw}> deklariert keinen Namensraum; erwartet wird "${DIP_NS}".`, en: `The envelope <${root.raw}> declares no namespace; expected "${DIP_NS}".` },
      ref: `${DIP_REF}, E0600`,
    });
  }
  if (!env.version) {
    add({
      severity: "error",
      line: root.line,
      code: "DIP_VERSION",
      message: { de: "Das Wurzelelement trägt kein version-Attribut.", en: "The root element carries no version attribute." },
      hint: { de: 'Für CARF-Lieferungen ist nur version="2.0" zulässig.', en: 'For CARF deliveries only version="2.0" is allowed.' },
      ref: DIP_REF,
    });
  } else if (env.version !== "2.0") {
    add({
      severity: "error",
      line: root.line,
      code: "DIP_VERSION",
      message: { de: `Umschlagversion "${env.version}" ist für CARF nicht zulässig; die Datensatzbeschreibung lässt nur 2.0 zu.`, en: `Envelope version "${env.version}" is not allowed for CARF; the Datensatzbeschreibung permits only 2.0.` },
      ref: DIP_REF,
    });
  }

  // A delivery that is ready to send carries the customer's enveloped XML
  // signature as a child of dip, after body (KHB DIP-Standard 2.4, 5.4.2:
  // SHA256-RSA-MGF1). The BZSt checks and removes it before schema
  // validation, which is why dip.xsd itself rejects a signature element. So
  // it is allowed here, and reported, not treated as an unknown element.
  checkSequence(root, [{ name: "header", min: 1, max: 1 }, { name: "body", min: 1, max: 1 }, { name: "Signature", min: 0, max: 1 }], add);
  const sig = root.children.find((c) => c.name === "Signature");
  if (sig) {
    env.signed = true;
    add({
      severity: "info",
      line: sig.line,
      code: "DIP_SIGNED",
      message: { de: "Die Lieferung trägt eine Enveloped-Signatur. Diese Seite prüft die Signatur nicht; das tut das BZSt vor der Schemaprüfung.", en: "The delivery carries an enveloped signature. This page does not verify it; the BZSt does, before schema validation." },
      hint: { de: "Eine Signatur gilt für genau diese Bytes. Jede spätere Änderung, auch eine Neuformatierung, macht sie ungültig.", en: "A signature covers exactly these bytes. Any later change, even reformatting, invalidates it." },
      ref: "KHB DIP-Standard 2.4, 5.4",
    });
  } else {
    add({
      severity: "info",
      line: root.line,
      code: "DIP_UNSIGNED",
      message: { de: "Die Lieferung ist nicht signiert. Zum Senden muss sie mit dem eigenen Schlüssel signiert werden (Enveloped-Signatur, SHA256-RSA-MGF1).", en: "The delivery is not signed. To send it, it must be signed with your own key (enveloped signature, SHA256-RSA-MGF1)." },
      ref: "KHB DIP-Standard 2.4, 5.4",
    });
  }

  const header = find(root, ["header"]);
  const body = find(root, ["body"]);

  if (header) {
    env.environment = header.attrs["environment"] ?? null;
    if (!env.environment || !DIP_ENVIRONMENTS.has(env.environment)) {
      add({
        severity: "error",
        line: header.line,
        code: "DIP_ENVIRONMENT",
        message: env.environment
          ? { de: `environment="${env.environment}" ist unbekannt; zulässig sind TEST und PROD.`, en: `environment="${env.environment}" is unknown; TEST and PROD are allowed.` }
          : { de: "Dem Header fehlt das Pflichtattribut environment (TEST oder PROD).", en: "The header is missing the required environment attribute (TEST or PROD)." },
        hint: { de: "Die Angabe muss zur angesprochenen Systemumgebung passen; eine Abweichung weist das BZSt mit E0700 ab.", en: "The value must match the system environment addressed; a mismatch is rejected by the BZSt with E0700." },
        ref: `${DIP_REF}, E0700`,
      });
    }
    checkSequence(header, [{ name: "consignment", min: 1, max: 1 }, { name: "application", min: 1, max: 1 }], add);

    const cons = find(header, ["consignment"]);
    if (cons) {
      checkSequence(
        cons,
        [
          { name: "customerIdentifier", min: 1, max: 1 },
          { name: "creationTime", min: 1, max: 1 },
          { name: "transferticketId", min: 1, max: 1 },
          { name: "referenceId", min: 0, max: 1 },
        ],
        add,
      );
      const cid = find(cons, ["customerIdentifier"]);
      if (cid) {
        checkSequence(cid, [{ name: "identityProvider", min: 1, max: 1 }, { name: "identifier", min: 1, max: 1 }], add);
        const prov = find(cid, ["identityProvider"]);
        if (prov) {
          env.identityProvider = prov.text.trim();
          if (!DIP_PROVIDERS.has(env.identityProvider)) {
            add({
              severity: "error",
              line: prov.line,
              code: "DIP_PROVIDER",
              message: { de: `identityProvider "${env.identityProvider}" ist unbekannt; zulässig sind BZST-CERT und ELSTER.`, en: `identityProvider "${env.identityProvider}" is unknown; BZST-CERT and ELSTER are allowed.` },
              ref: DIP_REF,
            });
          }
        }
        checkLength(find(cid, ["identifier"]), 1, 16, add);
      }
      const ct = find(cons, ["creationTime"]);
      if (ct && !DATETIME_RE.test(ct.text.trim())) {
        add({
          severity: "error",
          line: ct.line,
          code: "DIP_CREATIONTIME",
          message: { de: `creationTime "${ct.text.trim()}" ist kein xs:dateTime.`, en: `creationTime "${ct.text.trim()}" is not an xs:dateTime.` },
          hint: { de: "Erwartet wird z. B. 2027-07-15T09:30:00Z.", en: "Expected e.g. 2027-07-15T09:30:00Z." },
          ref: DIP_REF,
        });
      }
      const tt = find(cons, ["transferticketId"]);
      if (tt) env.transferticketId = tt.text.trim();
      checkLength(tt, 1, 170, add);
      const ref = find(cons, ["referenceId"]);
      if (ref) {
        env.referenceId = ref.text.trim();
        checkLength(ref, 1, 170, add);
        if (env.transferticketId && env.referenceId === env.transferticketId) {
          add({
            severity: "error",
            line: ref.line,
            code: "DIP_SELF_REFERENCE",
            message: { de: "referenceId ist identisch mit der eigenen transferticketId.", en: "referenceId equals this delivery's own transferticketId." },
            hint: { de: "referenceId verweist auf die transferticketId einer vorhergehenden Lieferung. Eine Lieferung kann sich nicht selbst referenzieren; das BZSt findet keine bekannte Bezugs-Lieferung (E1200).", en: "referenceId points to a previous delivery's transferticketId. A delivery cannot reference itself; the BZSt finds no known prior delivery (E1200)." },
            ref: `${DIP_REF}, E1200`,
          });
        }
      }
    }

    const app = find(header, ["application"]);
    if (app) {
      env.application = app.attrs["code"] ?? null;
      if (!env.application) {
        add({
          severity: "error",
          line: app.line,
          code: "DIP_APPLICATION_CODE",
          message: { de: "<application> trägt kein code-Attribut.", en: "<application> carries no code attribute." },
          hint: { de: 'Für CARF-Lieferungen ist code="CARF" anzugeben.', en: 'For CARF deliveries, code="CARF" is required.' },
          ref: DIP_REF,
        });
      } else if (env.application !== "CARF") {
        add({
          severity: "error",
          line: app.line,
          code: "DIP_APPLICATION_CODE",
          message: { de: `application code="${env.application}", für CARF-Lieferungen ist der Wert "CARF" zu verwenden.`, en: `application code="${env.application}"; CARF deliveries must use "CARF".` },
          hint: { de: "Der Code benennt das Ziel-Fachverfahren. Ein anderer Wert wird an ein anderes Verfahren geroutet oder mit E1300 abgewiesen.", en: "The code names the target procedure. A different value routes to a different procedure or is rejected with E1300." },
          ref: `${DIP_REF}, E1300`,
        });
      }
    }
  }

  let payload: XNode | null = null;
  if (body) {
    // A common misreading of the Datensatzbeschreibung's table puts
    // application under body. The schema and the handbook example put it in
    // the header; say so instead of only reporting an unknown element.
    const misplaced = find(body, ["application"]);
    if (misplaced) {
      add({
        severity: "error",
        line: misplaced.line,
        code: "DIP_APPLICATION_PLACE",
        message: { de: "<application> steht im Body; laut dip.xsd gehört es in den Header, nach <consignment>.", en: "<application> is in the body; per dip.xsd it belongs in the header, after <consignment>." },
        ref: `${DIP_REF}, ${KHB_REF} 5.3`,
      });
    }
    checkSequence(body, [{ name: "application", min: 0, max: 0 }, { name: "consignmentItem", min: 1, max: 1000 }], add);
    const items = body.children.filter((c) => c.name === "consignmentItem");
    if (items.length > 1) {
      add({
        severity: "error",
        line: items[1].line,
        code: "DIP_ONE_ITEM",
        message: { de: `Die Lieferung enthält ${items.length} consignmentItems; für CARF ist genau eines zulässig.`, en: `The delivery contains ${items.length} consignmentItems; CARF allows exactly one.` },
        ref: DIP_REF,
      });
    }
    const positions = new Map<string, number>();
    items.forEach((item, i) => {
      const pos = item.attrs["consignmentItemPosition"];
      if (pos === undefined || !/^\d+$/.test(pos)) {
        add({
          severity: "error",
          line: item.line,
          code: "DIP_POSITION",
          message: pos === undefined
            ? { de: "consignmentItem trägt kein consignmentItemPosition-Attribut.", en: "consignmentItem carries no consignmentItemPosition attribute." }
            : { de: `consignmentItemPosition="${pos}" ist keine nichtnegative ganze Zahl.`, en: `consignmentItemPosition="${pos}" is not a non-negative integer.` },
          ref: `${DIP_REF}, E0600`,
        });
      } else {
        if (i === 0 && pos !== "0") {
          add({
            severity: "warning",
            line: item.line,
            code: "DIP_POSITION_FIRST",
            message: { de: `Das erste consignmentItem hat die Position ${pos}; die Datensatzbeschreibung sieht 0 vor.`, en: `The first consignmentItem has position ${pos}; the Datensatzbeschreibung specifies 0.` },
            hint: { de: "Die Position wird im Rückgabeprotokoll (payloadResult) wiederholt und dient der Zuordnung. Das Schema verlangt nur Eindeutigkeit.", en: "The position is echoed in the response protocol (payloadResult) for correlation. The schema itself requires only uniqueness." },
            ref: DIP_REF,
          });
        }
        if (positions.has(pos)) {
          add({
            severity: "error",
            line: item.line,
            code: "DIP_POSITION_DUPLICATE",
            message: { de: `consignmentItemPosition ${pos} wird mehrfach verwendet (auch in Zeile ${positions.get(pos)}).`, en: `consignmentItemPosition ${pos} is used more than once (also on line ${positions.get(pos)}).` },
            ref: `${KHB_REF}, E0602`,
          });
        } else positions.set(pos, item.line);
      }
      checkSequence(item, [{ name: "bopAccountId", min: 0, max: 1 }, { name: "data", min: 1, max: 1 }], add);
      checkLength(find(item, ["bopAccountId"]), 1, 36, add);
      const data = find(item, ["data"]);
      if (data && i === 0) {
        const kids = data.children;
        if (kids.length !== 1 || kids[0].name !== "CARF_OECD") {
          add({
            severity: "error",
            line: data.line,
            code: "DIP_DATA_PAYLOAD",
            message: kids.length === 0
              ? { de: "<data> ist leer; erwartet werden die CARF-Nutzdaten <CARF_OECD>.", en: "<data> is empty; the CARF payload <CARF_OECD> is expected." }
              : kids.length > 1
                ? { de: `<data> enthält ${kids.length} Elemente; erwartet wird genau ein <CARF_OECD>.`, en: `<data> contains ${kids.length} elements; exactly one <CARF_OECD> is expected.` }
                : { de: `<data> enthält <${kids[0].raw}>; erwartet wird <CARF_OECD>.`, en: `<data> contains <${kids[0].raw}>; <CARF_OECD> is expected.` },
            hint: { de: "Die Nutzdaten sind die CARF-Nachricht nach OECD-Schema, unverändert in den Umschlag eingebettet.", en: "The payload is the CARF message under the OECD schema, embedded unchanged in the envelope." },
            ref: DIP_REF,
          });
        }
        if (kids.length === 1 && kids[0].name === "CARF_OECD") payload = kids[0];
      }
    });
  }
  return payload;
}

// --- the validator ------------------------------------------------------

export function validateCarf(src: string): ValidationResult {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  const summary: ValidationResult["summary"] = {
    rcaspCount: 0,
    userCount: 0,
    transactionElements: 0,
    messageTypeIndic: null,
    reportingPeriod: null,
    docTypeIndics: [],
    isTestData: false,
    envelope: null,
  };

  if (!src.trim()) {
    return {
      ok: false,
      summary,
      findings: [
        { severity: "error", line: 1, code: "EMPTY", message: { de: "Nichts zu prüfen: die Datei ist leer.", en: "Nothing to validate: the file is empty." } },
      ],
    };
  }

  const parsed = parseXml(src);
  if (parsed.error) return { ok: false, summary, findings: [parsed.error] };
  if (!parsed.root) return { ok: false, summary, findings: [] };
  let root: XNode = parsed.root;

  const isDelivery = root.name === "dip";
  checkDeclaration(src, isDelivery, add);
  if (isDelivery) {
    const payload = checkDip(root, add, summary);
    if (!payload) {
      findings.sort(bySeverityThenLine);
      return { ok: false, findings, summary };
    }
    root = payload;
  }

  // --- root ---
  if (root.name !== "CARF_OECD") {
    add({
      severity: "error",
      line: root.line,
      code: "ROOT_NAME",
      message: { de: `Wurzelelement ist <${root.raw}>, erwartet wird <CARF_OECD>.`, en: `Root element is <${root.raw}>, expected <CARF_OECD>.` },
      hint: { de: "Das Wurzelelement einer CARF-Nachricht ist CARF_OECD, üblicherweise mit dem Namensraum urn:oecd:ties:carf.", en: "A CARF message's root element is CARF_OECD, usually with the urn:oecd:ties:carf namespace." },
      ref: "CARF User Guide, Schema Information",
    });
  }
  if (root.name === "CARF_OECD") {
    const ns = resolvedNamespace(root);
    if (ns !== CARF_NAMESPACE) {
      add({
        severity: "error",
        line: root.line,
        code: "ROOT_NAMESPACE",
        message: {
          de: `Das Wurzelelement liegt im Namensraum ${ns === null ? "(keiner)" : `"${ns}"`}, das Schema verlangt ${CARF_NAMESPACE}.`,
          en: `The root element is in namespace ${ns === null ? "(none)" : `"${ns}"`}, the schema requires ${CARF_NAMESPACE}.`,
        },
        hint: {
          de: `Deklarieren Sie xmlns:carf="${CARF_NAMESPACE}" am Wurzelelement. Mit einem anderen Namensraum findet die Schemaprüfung des BZSt keine passende Deklaration.`,
          en: `Declare xmlns:carf="${CARF_NAMESPACE}" on the root element. In any other namespace the BZSt's schema check finds no matching declaration.`,
        },
        ref: "CARFXML_v1.5.xsd, targetNamespace",
      });
    }
  }
  const version = root.attrs["version"];
  if (!version) {
    add({
      severity: "warning",
      line: root.line,
      code: "ROOT_VERSION",
      message: { de: "Das Wurzelelement trägt kein version-Attribut.", en: "The root element carries no version attribute." },
      hint: { de: 'Meldungen deklarieren für das Schema vom Juli 2025 üblicherweise version="1.5".', en: 'Filings normally declare version="1.5" for the July 2025 schema.' },
      ref: "CARF XML Schema v1.5",
    });
  } else if (!/^1\.[05]$/.test(version)) {
    add({
      severity: "warning",
      line: root.line,
      code: "ROOT_VERSION_UNKNOWN",
      message: { de: `Schemaversion "${version}" kennt dieser Validator nicht (1.0, 1.5).`, en: `Schema version "${version}" is not one this validator knows (1.0, 1.5).` },
      ref: "CARF XML Schema v1.5, July 2025",
    });
  }

  // --- MessageSpec ---
  const spec = find(root, ["MessageSpec"]);
  if (!spec) {
    add({
      severity: "error",
      line: root.line,
      code: "NO_MESSAGESPEC",
      message: { de: "MessageSpec fehlt. Jede CARF-Nachricht braucht einen Nachrichtenkopf.", en: "MessageSpec is missing. Every CARF message needs a message header." },
      ref: "CARF User Guide, I. Message Header",
    });
  } else {
    const req = [
      "TransmittingCountry",
      "ReceivingCountry",
      "MessageType",
      "MessageRefId",
      "MessageTypeIndic",
      "ReportingPeriod",
      "Timestamp",
    ];
    for (const r of req) {
      // MessageRefId appears as MessageRefId in the schema; accept both casings
      const el =
        find(spec, [r]) ||
        (r === "MessageRefId" ? find(spec, ["MessageRefID"]) : null);
      if (!el) {
        add({
          severity: "error",
          line: spec.line,
          code: `MISSING_${r.toUpperCase()}`,
          message: { de: `Im MessageSpec fehlt das Pflichtelement <${r}>.`, en: `MessageSpec is missing the required element <${r}>.` },
          ref: "CARF User Guide, I. Message Header",
        });
      }
    }

    const tc = find(spec, ["TransmittingCountry"]);
    const rc = find(spec, ["ReceivingCountry"]);
    for (const [el, label] of [
      [tc, "TransmittingCountry"],
      [rc, "ReceivingCountry"],
    ] as const) {
      if (el && el.text && !KNOWN_COUNTRIES.has(el.text.trim().toUpperCase())) {
        add({
          severity: "warning",
          line: el.line,
          code: "COUNTRY_UNKNOWN",
          message: { de: `${label} "${el.text.trim()}" ist kein Ländercode, den dieser Validator kennt.`, en: `${label} "${el.text.trim()}" is not a country code this validator recognises.` },
          hint: { de: "Erforderlich ist ein ISO-3166-1-alpha-2-Code aus zwei Buchstaben, z. B. DE.", en: "Must be an ISO 3166-1 alpha-2 code, two letters, e.g. DE." },
          ref: "CARF User Guide, iso:CountryCode_Type",
        });
      }
      if (el && el.text && !/^[A-Za-z]{2}$/.test(el.text.trim())) {
        add({
          severity: "error",
          line: el.line,
          code: "COUNTRY_FORMAT",
          message: { de: `${label} muss genau zwei Buchstaben haben, gefunden wurde "${el.text.trim()}".`, en: `${label} must be exactly two letters, found "${el.text.trim()}".` },
          ref: "CARF User Guide, iso:CountryCode_Type",
        });
      }
    }

    const mt = find(spec, ["MessageType"]);
    if (mt && mt.text.trim() !== "CARF") {
      add({
        severity: "error",
        line: mt.line,
        code: "MESSAGETYPE",
        message: { de: `MessageType muss "CARF" sein, gefunden wurde "${mt.text.trim()}".`, en: `MessageType must be "CARF", found "${mt.text.trim()}".` },
        ref: "CARF User Guide, I. Message Header",
      });
    }

    const mti = find(spec, ["MessageTypeIndic"]);
    if (mti) {
      const v = mti.text.trim();
      summary.messageTypeIndic = v;
      if (!MESSAGE_TYPE_INDIC.has(v)) {
        add({
          severity: "error",
          line: mti.line,
          code: "MESSAGETYPEINDIC",
          message: { de: `MessageTypeIndic "${v}" ist nicht zulässig.`, en: `MessageTypeIndic "${v}" is not allowed.` },
          hint: { de: "CARF701 = Neudaten, CARF702 = Korrekturen/Löschungen, CARF703 = Nullmeldung.", en: "CARF701 = new data, CARF702 = corrections/deletions, CARF703 = nil report." },
          ref: "CARF User Guide, MessageTypeIndic",
        });
      }
    }

    const rp = find(spec, ["ReportingPeriod"]);
    if (rp) {
      const v = rp.text.trim();
      summary.reportingPeriod = v;
      if (!DATE_RE.test(v)) {
        add({
          severity: "error",
          line: rp.line,
          code: "REPORTINGPERIOD_FORMAT",
          message: { de: `ReportingPeriod muss yyyy-MM-DD sein, gefunden wurde "${v}".`, en: `ReportingPeriod must be yyyy-MM-DD, found "${v}".` },
          ref: "CARF User Guide, ReportingPeriod",
        });
      } else {
        const [, mm, dd] = v.split("-");
        if (!(mm === "12" && dd === "31")) {
          add({
            severity: "warning",
            line: rp.line,
            code: "REPORTINGPERIOD_NOT_YEAR_END",
            message: { de: `ReportingPeriod ist ${v} und damit kein 31.-Dezember-Jahresende.`, en: `ReportingPeriod is ${v}, which is not a 31 December year end.` },
            hint: { de: "Das Element trägt den LETZTEN Tag des Meldezeitraums. Für das Kalenderjahr 2026 ist das 2026-12-31.", en: "The element must carry the LAST day of the reporting period. For calendar year 2026 that is 2026-12-31." },
            ref: "CARF User Guide, ReportingPeriod",
          });
        }
      }
    }

    const ts = find(spec, ["Timestamp"]);
    if (ts && ts.text.trim() && !DATETIME_RE.test(ts.text.trim())) {
      add({
        severity: "error",
        line: ts.line,
        code: "TIMESTAMP_FORMAT",
        message: { de: `Timestamp "${ts.text.trim()}" ist kein gültiges xsd:dateTime.`, en: `Timestamp "${ts.text.trim()}" is not a valid xsd:dateTime.` },
        hint: { de: "Erwartet wird z. B. 2027-07-15T09:30:00Z.", en: "Expected e.g. 2027-07-15T09:30:00Z." },
        ref: "CARF User Guide, Timestamp",
      });
    }

    // MessageRefId convention: sending country + year + receiving country + unique part
    const mri = find(spec, ["MessageRefId"]) || find(spec, ["MessageRefID"]);
    if (mri) {
      const v = mri.text.trim();
      if (v.length > 170) {
        add({
          severity: "error",
          line: mri.line,
          code: "MESSAGEREFID_LENGTH",
          message: { de: `MessageRefId hat ${v.length} Zeichen, zulässig sind höchstens 170.`, en: `MessageRefId is ${v.length} characters, the maximum is 170.` },
          ref: "CARF User Guide, stf:StringMin1Max170_Type",
        });
      }
      const tcv = tc?.text.trim().toUpperCase() || "";
      const rcv = rc?.text.trim().toUpperCase() || "";
      const year = summary.reportingPeriod?.slice(0, 4) || "";
      if (tcv && !v.toUpperCase().startsWith(tcv)) {
        add({
          severity: "warning",
          line: mri.line,
          code: "MESSAGEREFID_PREFIX",
          message: { de: `MessageRefId sollte mit dem Ländercode des Senders "${tcv}" beginnen.`, en: `MessageRefId should start with the sending country code "${tcv}".` },
          hint: { de: `Die Konvention des Handbuchs lautet: Senderland, Meldejahr, Empfängerland, dann ein eindeutiger Teil. Z. B. ${tcv}${year || "2026"}${rcv || "DE"}0000001.`, en: `The User Guide's convention is sending country, then the reportable year, then the receiving country, then a unique part. E.g. ${tcv}${year || "2026"}${rcv || "DE"}0000001.` },
          ref: "CARF User Guide, MessageRefId",
        });
      } else if (tcv && year && !v.toUpperCase().startsWith(tcv + year)) {
        add({
          severity: "info",
          line: mri.line,
          code: "MESSAGEREFID_YEAR",
          message: { de: `MessageRefId setzt nach dem Ländercode nicht mit dem Meldejahr "${year}" fort.`, en: `MessageRefId does not continue with the reportable year "${year}" after the country code.` },
          hint: { de: "Das ist eine Konvention, keine Schemabedingung, aber die Finanzverwaltungen verfolgen Nachrichten darüber.", en: "This is a convention, not a schema constraint, but tax administrations rely on it to trace messages." },
          ref: "CARF User Guide, MessageRefId",
        });
      }
    }
  }

  // --- Body ---
  const body = find(root, ["CARFBody"]);
  const rcasps = body ? body.children.filter((c) => c.name === "RCASP") : [];
  summary.rcaspCount = rcasps.length;
  // CARFBody_Type: RCASP, then CryptoUsers 0..n, each one user record with
  // UserID (Individual or Entity), ControllingPerson 0..n, RelevantTransactions
  // 1..n and DocSpec. Until 19.10.2026 this validator counted an element
  // named CryptoAssetUser that does not exist in the schema.
  const users = body ? body.children.filter((c) => c.name === "CryptoUsers") : [];
  summary.userCount = users.length;
  for (const u of users) {
    const uid = find(u, ["UserID"]);
    const party = uid ? uid.children.find((c) => c.name === "Individual" || c.name === "Entity") : null;
    if (!uid || !party) {
      add({
        severity: "error",
        line: u.line,
        code: "USER_NO_ID",
        message: { de: "CryptoUsers-Datensatz ohne UserID mit Individual oder Entity.", en: "CryptoUsers record without a UserID holding Individual or Entity." },
        ref: "CARFXML_v1.5.xsd, CryptoUsers_Type",
      });
    }
    const rts = u.children.filter((c) => c.name === "RelevantTransactions");
    if (rts.length === 0) {
      add({
        severity: "error",
        line: u.line,
        code: "USER_NO_TRANSACTIONS",
        message: { de: "CryptoUsers-Datensatz ohne RelevantTransactions; mindestens ein Block ist Pflicht.", en: "CryptoUsers record without RelevantTransactions; at least one block is required." },
        hint: { de: "Ein Nutzer ohne meldepflichtige Transaktionen im Meldezeitraum gehört nicht in die Meldung.", en: "A user without relevant transactions in the reporting period does not belong in the message." },
        ref: "CARFXML_v1.5.xsd, CryptoUsers_Type",
      });
    }
    for (const rt of rts) {
      if (!find(rt, ["CryptoAsset"])?.text.trim()) {
        add({
          severity: "error",
          line: rt.line,
          code: "RT_NO_ASSET",
          message: { de: "RelevantTransactions ohne CryptoAsset.", en: "RelevantTransactions without CryptoAsset." },
          ref: "CARFXML_v1.5.xsd, RelevantTransactions_Type",
        });
      }
      const kinds = new Set(rt.children.filter((c) => TX_BLOCKS.has(c.name)).map((c) => c.name));
      if (kinds.size > 1) {
        add({
          severity: "error",
          line: rt.line,
          code: "RT_MIXED_KINDS",
          message: { de: `RelevantTransactions mischt ${Array.from(kinds).join(" und ")}; das Schema erlaubt je Element nur eine Art.`, en: `RelevantTransactions mixes ${Array.from(kinds).join(" and ")}; the schema allows one kind per element.` },
          hint: { de: "Für denselben Kryptowert ein zweites RelevantTransactions-Element mit demselben CryptoAsset anlegen.", en: "Add a second RelevantTransactions element with the same CryptoAsset for the other kind." },
          ref: "CARFXML_v1.5.xsd, RelevantTransactions_Type (xs:choice)",
        });
      }
    }
  }

  if (summary.messageTypeIndic === "CARF703") {
    if (users.length > 0) {
      add({
        severity: "error",
        line: body?.line || root.line,
        code: "NIL_WITH_USERS",
        message: { de: `Dies ist eine Nullmeldung (CARF703), enthält aber ${users.length} Nutzerdatensatz/-sätze.`, en: `This is a nil report (CARF703) but it contains ${users.length} Crypto-Asset User record(s).` },
        hint: { de: "Eine Nullmeldung enthält keine Nutzerdaten. Bei inländischer Nullmeldung steht im Body nur das RCASP-Element.", en: "A nil report carries no user data. For domestic nil reporting the body holds only the RCASP element." },
        ref: "CARF User Guide, MessageTypeIndic CARF703",
      });
    }
  } else if (!body) {
    add({
      severity: "error",
      line: root.line,
      code: "NO_BODY",
      message: { de: "CARFBody fehlt, und diese Nachricht ist keine Nullmeldung (CARF703).", en: "CARFBody is missing, and this message is not a nil report (CARF703)." },
      ref: "CARF User Guide, IV. CARF Body",
    });
  } else if (rcasps.length === 0) {
    add({
      severity: "error",
      line: body.line,
      code: "NO_RCASP",
      message: { de: "CARFBody enthält kein RCASP-Element.", en: "CARFBody contains no RCASP element." },
      hint: { de: "Jede Nachricht muss den meldenden Krypto-Dienstleister benennen, von dem sie stammt.", en: "Every message must identify the Reporting Crypto-Asset Service Provider it comes from." },
      ref: "CARF User Guide, RCASP",
    });
  }

  // Nexus
  for (const nx of findAll(root, "Nexus")) {
    const v = nx.text.trim();
    if (v && !NEXUS.has(v)) {
      add({
        severity: "error",
        line: nx.line,
        code: "NEXUS_VALUE",
        message: { de: `Nexus "${v}" ist kein zulässiger Wert.`, en: `Nexus "${v}" is not an allowed value.` },
        hint: { de: "CARF901 steuerliche Ansässigkeit, CARF902 Gründung, CARF903 Geschäftsleitung, CARF904 Betriebsstätte, CARF905 Zweigniederlassung, CARF906 Zulassung, CARF907 Ferndienstleistungen.", en: "CARF901 tax residence, CARF902 incorporation, CARF903 management, CARF904 place of business, CARF905 branch, CARF906 authorisation, CARF907 remote services." },
        ref: "CARF User Guide, Nexus",
      });
    }
  }

  // DocSpec / DocTypeIndic
  const docSpecs = findAll(root, "DocSpec");
  const docRefIds = new Map<string, number>();
  const indics = new Set<string>();
  for (const ds of docSpecs) {
    const dti = find(ds, ["DocTypeIndic"]);
    if (!dti) {
      add({
        severity: "error",
        line: ds.line,
        code: "DOCSPEC_NO_TYPE",
        message: { de: "DocSpec hat kein DocTypeIndic.", en: "DocSpec has no DocTypeIndic." },
        ref: "CARF User Guide, DocSpec Type",
      });
    } else {
      const v = dti.text.trim();
      indics.add(v);
      if (!DOC_TYPE_INDIC.has(v)) {
        add({
          severity: "error",
          line: dti.line,
          code: "DOCTYPEINDIC_VALUE",
          message: { de: `DocTypeIndic "${v}" ist kein zulässiger Wert.`, en: `DocTypeIndic "${v}" is not an allowed value.` },
          hint: { de: "OECD0 erneut gesendet, OECD1 neu, OECD2 korrigiert, OECD3 Löschung (OECD10-13 sind die Testdaten-Entsprechungen).", en: "OECD0 resend, OECD1 new, OECD2 corrected, OECD3 deletion (OECD10-13 are the test-data equivalents)." },
          ref: "CARF User Guide, DocTypeIndic",
        });
      }
      if (TEST_DOC_TYPES.has(v)) summary.isTestData = true;
    }
    const dri = find(ds, ["DocRefId"]) || find(ds, ["DocRefID"]);
    if (!dri || !dri.text.trim()) {
      add({
        severity: "error",
        line: ds.line,
        code: "DOCSPEC_NO_REFID",
        message: { de: "DocSpec hat keine DocRefId.", en: "DocSpec has no DocRefId." },
        hint: { de: "Jeder Datensatz braucht eine eindeutige Referenz, damit er später korrigiert werden kann.", en: "Each record needs a unique reference so it can be corrected later." },
        ref: "CARF User Guide, DocSpec Type",
      });
    } else {
      const v = dri.text.trim();
      if (docRefIds.has(v)) {
        add({
          severity: "error",
          line: dri.line,
          code: "DOCREFID_DUPLICATE",
          message: { de: `DocRefId "${v}" wird mehrfach verwendet (auch in Zeile ${docRefIds.get(v)}).`, en: `DocRefId "${v}" is used more than once (also on line ${docRefIds.get(v)}).` },
          hint: { de: "DocRefIds müssen eindeutig sein; ein Duplikat macht eine spätere Korrektur mehrdeutig.", en: "DocRefIds must be unique; a duplicate makes a later correction ambiguous." },
          ref: "CARF User Guide, Corrections",
        });
      } else {
        docRefIds.set(v, dri.line);
      }
    }
  }
  summary.docTypeIndics = Array.from(indics).sort();

  // Correction references. CorrDocRefId must name the record being corrected
  // or deleted (the latest DocRefId sent for it); CorrMessageRefId names the
  // message that carried it. Sources: OECD CARF XML Schema User Guide, July
  // 2025, Corrections (the RCASP cannot be deleted without deleting every
  // related CryptoUsers record, either in the same message or earlier);
  // Datensatzbeschreibung 17.11.2025, stf:CorrDocRefId and stf:CorrMessageRefId.
  const thisMessageRef = (find(root, ["MessageSpec", "MessageRefId"]) || find(root, ["MessageSpec", "MessageRefID"]))?.text.trim();
  let rcaspType: string | null = null;
  const userTypes: string[] = [];
  for (const ds of docSpecs) {
    const v = find(ds, ["DocTypeIndic"])?.text.trim() ?? "";
    const ownRef = (find(ds, ["DocRefId"]) || find(ds, ["DocRefID"]))?.text.trim() ?? "";
    const corrDoc = find(ds, ["CorrDocRefId"]);
    const corrMsg = find(ds, ["CorrMessageRefId"]);
    const kind = ds.parent?.name;
    if (kind === "RCASP") rcaspType = v;
    else if (kind === "CryptoUsers") userTypes.push(v);
    if ((v === "OECD0" || v === "OECD10") && kind === "CryptoUsers") {
      add({
        severity: "error",
        line: ds.line,
        code: "OECD0_NOT_RCASP",
        message: { de: `${v} (erneut gesendet) steht an einem Nutzerdatensatz; zulässig ist es nur für das RCASP-Element.`, en: `${v} (resent) is on a user record; it is allowed only for the RCASP element.` },
        hint: { de: "Ein unveränderter Nutzer wird in einer Korrekturmeldung nicht erneut gesendet, sondern weggelassen. Ein erneut gesendetes RCASP behält die DocRefId, die das BZSt bereits hält.", en: "An unchanged user is left out of a correction message, not resent. A resent RCASP keeps the DocRefId the BZSt already holds." },
        ref: "CARF User Guide, DocSpec Type (OECD0)",
      });
    }
    const corrective = v === "OECD2" || v === "OECD3" || v === "OECD12" || v === "OECD13";
    if (corrective && !corrDoc?.text.trim()) {
      add({
        severity: "error",
        line: ds.line,
        code: "CORR_NO_REF",
        message: { de: `${v} (${v === "OECD2" || v === "OECD12" ? "Korrektur" : "Löschung"}) ohne CorrDocRefId: der Datensatz, der ersetzt wird, ist nicht benannt.`, en: `${v} (${v === "OECD2" || v === "OECD12" ? "correction" : "deletion"}) without CorrDocRefId: the record being replaced is not named.` },
        hint: { de: "CorrDocRefId verweist auf die zuletzt übermittelte DocRefId dieses Datensatzes. Ohne sie kann das BZSt die Korrektur keinem Datensatz zuordnen.", en: "CorrDocRefId points to the latest DocRefId sent for this record. Without it the BZSt cannot match the correction to a record." },
        ref: "CARF User Guide, Corrections; Datensatzbeschreibung 17.11.2025, stf:CorrDocRefId",
      });
    }
    if (corrective && !corrMsg?.text.trim()) {
      add({
        severity: "warning",
        line: ds.line,
        code: "CORR_NO_MESSAGE_REF",
        message: { de: "Korrektur oder Löschung ohne CorrMessageRefId.", en: "Correction or deletion without CorrMessageRefId." },
        hint: { de: "Die Datensatzbeschreibung nennt dort die MessageRefId der Meldung, die den Datensatz zuletzt enthielt.", en: "The Datensatzbeschreibung puts there the MessageRefId of the message that last carried the record." },
        ref: "Datensatzbeschreibung 17.11.2025, stf:CorrMessageRefId",
      });
    }
    if (!corrective && corrDoc) {
      const isNew = v === "OECD1" || v === "OECD11";
      add({
        severity: isNew ? "error" : "warning",
        line: corrDoc.line,
        code: "CORR_ON_NON_CORRECTION",
        message: { de: `${v} trägt eine CorrDocRefId; nur OECD2 und OECD3 verweisen auf einen früheren Datensatz.`, en: `${v} carries a CorrDocRefId; only OECD2 and OECD3 refer to an earlier record.` },
        ref: "CARF User Guide, Corrections",
      });
    }
    if (corrDoc && ownRef && corrDoc.text.trim() === ownRef) {
      add({
        severity: "error",
        line: corrDoc.line,
        code: "CORR_SELF_REF",
        message: { de: "CorrDocRefId ist gleich der eigenen DocRefId.", en: "CorrDocRefId equals the record's own DocRefId." },
        hint: { de: "Jede Korrektur braucht eine neue, eindeutige DocRefId; die CorrDocRefId nennt die alte.", en: "Every correction needs a new unique DocRefId; CorrDocRefId names the old one." },
        ref: "CARF User Guide, Corrections",
      });
    }
    if (corrMsg && thisMessageRef && corrMsg.text.trim() === thisMessageRef) {
      add({
        severity: "error",
        line: corrMsg.line,
        code: "CORR_MESSAGE_SELF",
        message: { de: "CorrMessageRefId ist gleich der MessageRefId dieser Nachricht.", en: "CorrMessageRefId equals this message's own MessageRefId." },
        ref: "Datensatzbeschreibung 17.11.2025, stf:CorrMessageRefId",
      });
    }
  }
  if (rcaspType === "OECD3" && userTypes.some((t) => t !== "OECD3")) {
    add({
      severity: "error",
      line: root.line,
      code: "RCASP_DELETE_WITH_USERS",
      message: { de: "Das RCASP wird gelöscht (OECD3), die Nachricht enthält aber Nutzerdatensätze, die nicht ebenfalls gelöscht werden.", en: "The RCASP is deleted (OECD3) but the message holds user records that are not deleted too." },
      hint: { de: "Das RCASP kann nicht gelöscht werden, ohne alle zugehörigen Nutzerdatensätze zu löschen, in derselben oder einer früheren Nachricht.", en: "The RCASP cannot be deleted without deleting all related user records, in the same or an earlier message." },
      ref: "CARF User Guide, DocTypeIndic",
    });
  }

  // Cross-rule: message type against document types
  const prodIndics = Array.from(indics).filter((i) => !TEST_DOC_TYPES.has(i));
  if (summary.messageTypeIndic === "CARF701") {
    const bad = prodIndics.filter((i) => i === "OECD2" || i === "OECD3");
    if (bad.length) {
      add({
        severity: "error",
        line: spec?.line || root.line,
        code: "NEW_WITH_CORRECTIONS",
        message: { de: `MessageTypeIndic ist CARF701 (Neumeldung), die Nachricht enthält aber ${bad.join(", ")}.`, en: `MessageTypeIndic is CARF701 (new data) but the message contains ${bad.join(", ")}.` },
        hint: { de: "Korrekturen und Löschungen gehören in eine CARF702-Nachricht. Trennen Sie sie in eine eigene Abgabe.", en: "Corrections and deletions belong in a CARF702 message. Split them into a separate filing." },
        ref: "CARF User Guide, MessageTypeIndic / DocTypeIndic combinations",
      });
    }
  }
  if (summary.messageTypeIndic === "CARF702") {
    if (prodIndics.includes("OECD1")) {
      add({
        severity: "error",
        line: spec?.line || root.line,
        code: "CORRECTION_WITH_NEW",
        message: { de: "MessageTypeIndic ist CARF702 (Korrektur), die Nachricht enthält aber OECD1 (Neudaten).", en: "MessageTypeIndic is CARF702 (corrections) but the message contains OECD1 (new data)." },
        hint: { de: "Eine Korrekturmeldung darf OECD2 und OECD3 enthalten, dazu OECD0 für das RCASP-Element. Neudaten gehören in eine eigene CARF701-Nachricht.", en: "A correction message may contain OECD2 and OECD3, plus OECD0 for the RCASP element. New data must go in its own CARF701 message." },
        ref: "CARF User Guide, MessageTypeIndic / DocTypeIndic combinations",
      });
    }
  }
  if (summary.isTestData && prodIndics.length) {
    add({
      severity: "error",
      line: root.line,
      code: "TEST_PROD_MIX",
      message: { de: "Die Nachricht mischt Test-DocTypeIndic-Werte (OECD10-13) mit Echtdaten-Werten.", en: "The message mixes test DocTypeIndic values (OECD10-13) with production values." },
      hint: { de: "Eine Datei ist entweder ein Test oder eine Abgabe. Die Mischung ist der klassische Weg, echte Daten ignorieren oder Testdaten als echt annehmen zu lassen.", en: "A file is either a test or a filing. Mixing the two is the classic way to have real data ignored, or test data accepted as real." },
      ref: "CARF User Guide, DocTypeIndic",
    });
  }
  if (summary.isTestData) {
    add({
      severity: "warning",
      line: root.line,
      code: "TEST_DATA",
      message: { de: "Diese Nachricht ist als TESTDATEN gekennzeichnet (OECD10-13).", en: "This message is marked as TEST data (OECD10-13)." },
      hint: { de: "Richtig für eine Testabgabe. Wenn es eine echte Meldung werden soll, verwenden Sie OECD0-3.", en: "Correct for a test submission. If you meant to file for real, use OECD0-3." },
      ref: "CARF User Guide, DocTypeIndic",
    });
  }

  // Amounts and units
  for (const amt of findAll(root, "Amount")) {
    summary.transactionElements++;
    const cur = amt.attrs["currCode"];
    if (!cur) {
      add({
        severity: "error",
        line: amt.line,
        code: "AMOUNT_NO_CURRENCY",
        message: { de: "Amount hat kein currCode-Attribut.", en: "Amount has no currCode attribute." },
        hint: { de: 'Jeder Geldbetrag trägt seine Währung, z. B. <Amount currCode="EUR">1000</Amount>.', en: 'Every monetary amount carries its currency, e.g. <Amount currCode="EUR">1000</Amount>.' },
        ref: "CARF User Guide, cfc:MonAmnt_Type",
      });
    } else if (!/^[A-Za-z]{3}$/.test(cur)) {
      add({
        severity: "error",
        line: amt.line,
        code: "CURRENCY_FORMAT",
        message: { de: `currCode "${cur}" muss ein dreistelliger ISO-4217-Code sein.`, en: `currCode "${cur}" must be a three-letter ISO 4217 code.` },
        ref: "CARF User Guide, iso:currCode_Type",
      });
    } else if (!SCHEMA_CURRENCIES.has(cur)) {
      add({
        severity: "error",
        line: amt.line,
        code: "CURRENCY_UNKNOWN",
        message: { de: `currCode "${cur}" steht nicht in der Währungsliste des Schemas.`, en: `currCode "${cur}" is not in the schema's list of currencies.` },
        hint: { de: "Erlaubt sind die ISO-4217-Codes aus dem OECD-Schema, in Großbuchstaben, z. B. EUR.", en: "Allowed are the ISO 4217 codes the OECD schema lists, in capitals, e.g. EUR." },
        ref: "CARFXML_v1.5.xsd, iso:currCode_Type",
      });
    }
    const v = amt.text.trim();
    if (v && !/^-?\d+(\.\d+)?$/.test(v)) {
      add({
        severity: "error",
        line: amt.line,
        code: "AMOUNT_FORMAT",
        message: { de: `Amount "${v}" ist keine Zahl.`, en: `Amount "${v}" is not a number.` },
        hint: { de: "Verwenden Sie eine schlichte Dezimalzahl mit Punkt, ohne Tausendertrennzeichen und ohne Währungszeichen.", en: "Use a plain decimal with a dot, no thousands separators and no currency symbol." },
        ref: "CARF User Guide, cfc:MonAmnt_Type",
      });
    } else if (v.startsWith("-")) {
      add({
        severity: "warning",
        line: amt.line,
        code: "AMOUNT_NEGATIVE",
        message: { de: `Amount ist negativ (${v}).`, en: `Amount is negative (${v}).` },
        hint: { de: "CARF-Aggregate werden als positive Beträge gemeldet; die Richtung ergibt sich aus dem Element, in dem sie stehen.", en: "CARF aggregates are reported as positive amounts; direction is expressed by which element they sit in." },
        ref: "CARF User Guide, Relevant Transactions",
      });
    }
  }

  for (const nu of findAll(root, "NumberofUnits").concat(findAll(root, "NumberOfUnits"))) {
    const v = nu.text.trim();
    if (v && !/^-?\d+(\.\d+)?$/.test(v)) {
      add({
        severity: "error",
        line: nu.line,
        code: "UNITS_FORMAT",
        message: { de: `NumberofUnits "${v}" ist keine Dezimalzahl.`, en: `NumberofUnits "${v}" is not a decimal number.` },
        ref: "CARF User Guide, xsd:decimal",
      });
    }
  }

  for (const nt of findAll(root, "NumberofTransactions").concat(findAll(root, "NumberOfTransactions"))) {
    const v = nt.text.trim();
    if (v && !/^\d+$/.test(v)) {
      add({
        severity: "error",
        line: nt.line,
        code: "TXCOUNT_FORMAT",
        message: { de: `NumberofTransactions "${v}" ist keine ganze Zahl.`, en: `NumberofTransactions "${v}" is not a whole number.` },
        ref: "CARF User Guide, xsd:integer",
      });
    } else if (v === "0") {
      add({
        severity: "warning",
        line: nt.line,
        code: "TXCOUNT_ZERO",
        message: { de: "NumberofTransactions ist 0 in einem gemeldeten Transaktionsblock.", en: "NumberofTransactions is 0 on a reported transaction block." },
        hint: { de: "Ein Block ohne Transaktionen wird üblicherweise ganz weggelassen.", en: "A block with no transactions is usually meant to be omitted entirely." },
      });
    }
  }

  for (const tt of findAll(root, "TransferType")) {
    const v = tt.text.trim();
    const inbound = tt.parent?.name === "CryptoTransferIn";
    const allowed = inbound ? TRANSFER_IN_TYPE : TRANSFER_OUT_TYPE;
    if (v && !allowed.has(v)) {
      add({
        severity: "error",
        line: tt.line,
        code: "TRANSFERTYPE_VALUE",
        message: inbound
          ? { de: `TransferType "${v}" ist für CryptoTransferIn nicht zulässig (CARF501 bis CARF509).`, en: `TransferType "${v}" is not allowed for CryptoTransferIn (CARF501 to CARF509).` }
          : { de: `TransferType "${v}" ist für CryptoTransferOut nicht zulässig (CARF601 bis CARF606).`, en: `TransferType "${v}" is not allowed for CryptoTransferOut (CARF601 to CARF606).` },
        hint: inbound
          ? { de: "CARF501 Airdrop, CARF502 Staking, CARF503 Mining, CARF504 Krypto-Darlehen, CARF505 von einem anderen Anbieter, CARF506 Verkauf von Waren oder Dienstleistungen, CARF507 Sicherheit, CARF508 sonstiges, CARF509 unbekannt.", en: "CARF501 airdrop, CARF502 staking income, CARF503 mining income, CARF504 crypto loan, CARF505 from another RCASP, CARF506 sale of goods or services, CARF507 collateral, CARF508 other, CARF509 unknown." }
          : { de: "CARF601 Transfer an einen anderen Anbieter, CARF602 Krypto-Darlehen, CARF603 Kauf von Waren oder Dienstleistungen, CARF604 Sicherheit, CARF605 sonstiges, CARF606 unbekannt.", en: "CARF601 transfer to another RCASP, CARF602 crypto loan, CARF603 purchase of goods or services, CARF604 collateral, CARF605 other, CARF606 unknown." },
        ref: "CARF User Guide, TransferType",
      });
    }
  }
  for (const [name, allowed, label] of [
    ["ExchangeType", EXCHANGE_TYPE, "CARF401 bis CARF404 / CARF401 to CARF404"],
    ["AltValuation", ALT_VALUATION, "CARF1001 bis CARF1004 / CARF1001 to CARF1004"],
    ["CtrlgPersonType", CTRLG_PERSON_TYPE, "CARF801 bis CARF813 / CARF801 to CARF813"],
  ] as const) {
    for (const el of findAll(root, name)) {
      const v = el.text.trim();
      if (v && !allowed.has(v)) {
        const [de, en] = label.split(" / ");
        add({
          severity: "error",
          line: el.line,
          code: `${name.toUpperCase()}_VALUE`,
          message: { de: `${name} "${v}" ist kein zulässiger Wert (${de}).`, en: `${name} "${v}" is not an allowed value (${en}).` },
          ref: `CARFXML_v1.5.xsd, ${name}`,
        });
      }
    }
  }

  // Country codes. The schema types five elements and the issuedBy attribute
  // of TIN/IN as ISO 3166 codes from a closed list; a code outside it fails
  // the BZSt's schema check however plausible it looks.
  for (const name of ["ResCountryCode", "Nationality", "CountryCode", "TransmittingCountry", "ReceivingCountry"]) {
    for (const el of findAll(root, name)) {
      const v = el.text.trim();
      if (v && !SCHEMA_COUNTRIES.has(v)) {
        add({
          severity: "error",
          line: el.line,
          code: "COUNTRY_NOT_IN_SCHEMA",
          message: { de: `${name} "${v}" steht nicht in der Länderliste des Schemas.`, en: `${name} "${v}" is not in the schema's list of countries.` },
          hint: { de: "Erforderlich ist ein ISO-3166-1-alpha-2-Code aus der Liste des OECD-Schemas, in Großbuchstaben, z. B. DE.", en: "Must be an ISO 3166-1 alpha-2 code from the OECD schema's list, in capitals, e.g. DE." },
          ref: "CARFXML_v1.5.xsd, iso:CountryCode_Type",
        });
      }
    }
  }
  for (const name of ["TIN", "IN", "IIN"]) {
    for (const el of findAll(root, name)) {
      const v = el.attrs["issuedBy"];
      if (v !== undefined && !SCHEMA_COUNTRIES.has(v.trim())) {
        add({
          severity: "error",
          line: el.line,
          code: "COUNTRY_NOT_IN_SCHEMA",
          message: { de: `issuedBy "${v}" an ${name} steht nicht in der Länderliste des Schemas.`, en: `issuedBy "${v}" on ${name} is not in the schema's list of countries.` },
          hint: { de: "Erforderlich ist ein ISO-3166-1-alpha-2-Code aus der Liste des OECD-Schemas, z. B. DE.", en: "Must be an ISO 3166-1 alpha-2 code from the OECD schema's list, e.g. DE." },
          ref: "CARFXML_v1.5.xsd, iso:CountryCode_Type",
        });
      }
    }
  }

  // Every person (Individual) and organisation (Entity) carries at least one
  // TIN. The schema requires it (PersonParty_Type and OrganisationParty_Type); a party whose
  // TIN is unknown reports unknown="true" with the value NOTIN.
  for (const party of [...findAll(root, "Individual"), ...findAll(root, "Entity")]) {
    if (!party.children.some((c) => c.name === "TIN")) {
      add({
        severity: "error",
        line: party.line,
        code: "TIN_MISSING",
        message: {
          de: `<${party.raw}> hat kein TIN-Element. Das Schema verlangt mindestens eines je Person und je Rechtsträger.`,
          en: `<${party.raw}> has no TIN element. The schema requires at least one for every person and organisation.`,
        },
        hint: {
          de: 'Ist die Steuer-Identifikationsnummer unbekannt, melden Sie <TIN unknown="true">NOTIN</TIN>.',
          en: 'If the tax identification number is unknown, report <TIN unknown="true">NOTIN</TIN>.',
        },
        ref: "CARFXML_v1.5.xsd, PersonParty_Type / OrganisationParty_Type",
      });
    }
  }

  // Birth dates are xs:date: a real calendar day, not 31.02.1980 or 1980-02-31.
  for (const bd of findAll(root, "BirthDate")) {
    const v = bd.text.trim();
    if (!isRealDate(v)) {
      add({
        severity: "error",
        line: bd.line,
        code: "BIRTHDATE_INVALID",
        message: { de: `BirthDate "${v}" ist kein gültiges Datum im Format JJJJ-MM-TT.`, en: `BirthDate "${v}" is not a valid date in the format YYYY-MM-DD.` },
        hint: { de: "Das Schema erwartet xs:date, z. B. 1990-05-04, mit einem Tag, den es in diesem Monat gibt.", en: "The schema expects xs:date, e.g. 1990-05-04, with a day that exists in that month." },
        ref: "CARFXML_v1.5.xsd, BirthDate",
      });
    } else if (Number(v.slice(0, 4)) < 1900) {
      add({
        severity: "warning",
        line: bd.line,
        code: "BIRTHDATE_RANGE",
        message: { de: `BirthDate "${v}" liegt vor 1900.`, en: `BirthDate "${v}" is before 1900.` },
        hint: { de: "Meist ein Eingabefehler, etwa ein vertauschtes Jahr.", en: "Usually an entry error, such as a mistyped year." },
      });
    }
  }

  // A German IdNr that fails its own check digit is a typo, not a number the
  // Finanzamt can match. A warning, not an error: the BZSt's acceptance rule
  // for the digit is not published, and only individuals carry an IdNr.
  for (const ind of findAll(root, "Individual")) {
    const resDE = ind.children.some((c) => c.name === "ResCountryCode" && c.text.trim() === "DE");
    for (const t of ind.children.filter((c) => c.name === "TIN")) {
      const v = t.text.trim();
      if (/^\d{11}$/.test(v) && (t.attrs["issuedBy"] === "DE" || (t.attrs["issuedBy"] === undefined && resDE)) && !idnrCheckDigitOk(v)) {
        add({
          severity: "warning",
          line: t.line,
          code: "DE_IDNR_CHECKDIGIT",
          message: { de: `Die Steuer-IdNr "${v}" besteht ihre eigene Prüfziffer nicht.`, en: `The German IdNr "${v}" fails its own check digit.` },
          hint: { de: "Vermutlich ein Zahlendreher oder ein Tippfehler. Prüfen Sie die Nummer gegen die Selbstauskunft des Nutzers.", en: "Probably a transposed or mistyped digit. Check the number against the user's self-certification." },
          ref: "ISO 7064 MOD 11,10, as used for the Steuer-Identifikationsnummer",
        });
      }
    }
  }

  // TINs: presence is the single most common real-world defect
  const tins = findAll(root, "TIN");
  for (const t of tins) {
    const value = t.text.trim();
    const unknown = (t.attrs["unknown"] ?? "").trim().toLowerCase() === "true" || t.attrs["unknown"] === "1";
    if (!value) {
      add({
        severity: "error",
        line: t.line,
        code: "TIN_EMPTY",
        message: { de: "Ein TIN-Element ist vorhanden, aber leer.", en: "A TIN element is present but empty." },
        hint: unknown
          ? { de: "Bei unknown=\"true\" ist der Wert NOTIN einzutragen. Ein leeres Element besteht die Schemaprüfung für Rechtsträger nicht.", en: "With unknown=\"true\" the value must be NOTIN. An empty element fails the schema check for an entity." }
          : { de: "Melden Sie die Steuer-Identifikationsnummer. Fehlt sie, setzen Sie unknown=\"true\" und tragen Sie NOTIN ein.", en: "Report the tax identification number. If there is none, set unknown=\"true\" and enter NOTIN." },
        ref: "CARF User Guide, TIN",
      });
    } else if (unknown && value !== "NOTIN") {
      add({
        severity: "error",
        line: t.line,
        code: "TIN_UNKNOWN_VALUE",
        message: { de: `TIN ist als unknown markiert, der Wert lautet aber "${value}" statt NOTIN.`, en: `The TIN is flagged unknown, but its value is "${value}" instead of NOTIN.` },
        hint: { de: "Bei unknown=\"true\" gilt ausschließlich der Wert NOTIN; andere Werte lehnt die Prüfung ab.", en: "With unknown=\"true\" only the value NOTIN is accepted; other values are rejected." },
        ref: "OECD CARF XML Schema User Guide, TIN",
      });
    }
  }
  if (users.length > 0 && tins.length === 0) {
    add({
      severity: "warning",
      line: body?.line || root.line,
      code: "NO_TINS",
      message: { de: `Die Nachricht meldet ${users.length} Nutzer, enthält aber überhaupt kein TIN-Element.`, en: `The message reports ${users.length} user(s) but contains no TIN element at all.` },
      hint: { de: "Steuer-Identifikationsnummern sind der Kern des Austauschs. Ihr vollständiges Fehlen bedeutet meist eine übersehene Zuordnung.", en: "Tax identification numbers are the core of the exchange. Their complete absence usually means a mapping was missed." },
      ref: "CARF User Guide, II/III Party Types",
    });
  }

  // --- German BZSt filing conventions ---
  const tcv = find(root, ["MessageSpec", "TransmittingCountry"])?.text.trim().toUpperCase();
  const rcv = find(root, ["MessageSpec", "ReceivingCountry"])?.text.trim().toUpperCase();
  if (tcv === "DE" && rcv && rcv !== "DE") {
    add({
      severity: "info",
      line: spec?.line || root.line,
      code: "DE_DOMESTIC",
      message: { de: `TransmittingCountry ist DE, ReceivingCountry aber ${rcv}.`, en: `TransmittingCountry is DE but ReceivingCountry is ${rcv}.` },
      hint: { de: "Bei einer inländischen Abgabe eines deutschen Anbieters an das BZSt ist beides üblicherweise DE. Ein anderes Empfängerland deutet auf eine Austauschnachricht zwischen Behörden hin, was nicht Aufgabe eines Anbieters ist.", en: "For a domestic filing by a German CASP to the BZSt, both are normally DE. A different receiving country indicates an international exchange message, which is a competent authority's job, not a CASP's." },
      ref: "KStTG, BZSt filing",
    });
  }
  if (summary.reportingPeriod) {
    const y = Number(summary.reportingPeriod.slice(0, 4));
    if (y < 2026) {
      add({
        severity: "warning",
        line: root.line,
        code: "DE_PERIOD_EARLY",
        message: { de: `Das Jahr des ReportingPeriod ist ${y} und liegt vor dem ersten deutschen Meldezeitraum.`, en: `ReportingPeriod year is ${y}, before the first German reportable period.` },
        hint: { de: "Die deutsche Erfassungspflicht beginnt am 01.01.2026; erster Meldezeitraum ist 2026, abzugeben bis 31.07.2027.", en: "Germany's collection duty starts 01.01.2026; the first reportable period is 2026, filed by 31.07.2027." },
        ref: "KStTG",
      });
    }
  }

  // Datensatzbeschreibung 17.11.2025, stf:DocRefId: must begin with the
  // transmitting country code, followed by the reporting period, then a
  // free unique part. Example given there: DE20261234567.
  if (tcv && summary.reportingPeriod) {
    const year = summary.reportingPeriod.slice(0, 4);
    const refs = findAll(root, "DocRefId").concat(findAll(root, "DocRefID"));
    for (const r of refs) {
      const v = r.text.trim();
      if (v && !v.toUpperCase().startsWith(tcv + year)) {
        add({
          severity: "warning",
          line: r.line,
          code: "DOCREFID_PREFIX",
          message: { de: `DocRefId "${v}" beginnt nicht mit Staatencode und Meldezeitraum "${tcv}${year}".`, en: `DocRefId "${v}" does not start with country code and reporting period "${tcv}${year}".` },
          hint: { de: "Die deutsche Datensatzbeschreibung verlangt: Staatencode des übermittelnden Staates, dann Meldezeitraum, dann ein eindeutiger Bezeichner. Beispiel dort: DE20261234567.", en: "The German Datensatzbeschreibung requires: transmitting country code, then reporting period, then a unique identifier. Its example: DE20261234567." },
          ref: "Datensatzbeschreibung 17.11.2025, stf:DocRefId",
        });
      }
    }
  }

  // Envelope environment against the kind of data inside it. The
  // Datensatzbeschreibung: test data only under TEST, production data only
  // under PROD, so that the two are never mixed.
  const env = summary.envelope;
  if (env?.environment === "PROD" && summary.isTestData) {
    add({
      severity: "error",
      line: parsed.root.line,
      code: "DIP_PROD_WITH_TESTDATA",
      message: { de: "Der Umschlag ist mit environment=\"PROD\" markiert, die Nutzdaten tragen aber Test-DocTypeIndics (OECD10 bis OECD13).", en: 'The envelope is marked environment="PROD" but the payload carries test DocTypeIndics (OECD10 to OECD13).' },
      hint: { de: "Testdaten dürfen nur unter TEST übermittelt werden. Entweder den Umschlag auf TEST setzen oder die DocTypeIndics auf OECD1 bis OECD3 ändern.", en: "Test data may only be delivered under TEST. Either set the envelope to TEST or change the DocTypeIndics to OECD1 to OECD3." },
      ref: DIP_REF,
    });
  }
  if (env?.environment === "TEST" && !summary.isTestData && summary.docTypeIndics.length) {
    add({
      severity: "warning",
      line: parsed.root.line,
      code: "DIP_TEST_WITH_PRODDATA",
      message: { de: "Der Umschlag ist mit environment=\"TEST\" markiert, die Nutzdaten tragen aber Produktiv-DocTypeIndics (OECD1 bis OECD3).", en: 'The envelope is marked environment="TEST" but the payload carries production DocTypeIndics (OECD1 to OECD3).' },
      hint: { de: "Für die Testumgebung sind OECD10 bis OECD13 vorgesehen. Produktivdaten dürfen nur unter PROD übermittelt werden; für eine Probelieferung die DocTypeIndics umstellen.", en: "The test environment expects OECD10 to OECD13. Production data may only be delivered under PROD; for a trial delivery switch the DocTypeIndics." },
      ref: DIP_REF,
    });
  }

  // The plain schema: element order and counts, required attributes, and what
  // every value may be. The specific checks above say more about a defect than
  // a schema message can, so a schema finding on a line that already carries
  // an error is dropped as a duplicate.
  if (root.name === "CARF_OECD") {
    const errLines = new Set(findings.filter((f) => f.severity === "error").map((f) => f.line));
    checkStructure(root, (f) => {
      if (!errLines.has(f.line)) add(f);
    });
  }

  const hasError = findings.some((f) => f.severity === "error");
  findings.sort(bySeverityThenLine);
  return { ok: !hasError, findings, summary };
}

export function bySeverityThenLine(a: Finding, b: Finding): number {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return rank[a.severity] - rank[b.severity] || a.line - b.line;
}
