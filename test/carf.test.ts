// Tests for the CARF validator. Run: npm run test:carf
//
// Every case here is a defect a real filing can carry. The fixtures are
// deliberately minimal so a failure names one thing.

import { validateCarf, parseXml } from "../src/carf.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const VALID = `<?xml version="1.0" encoding="UTF-8"?>
<carf:CARF_OECD xmlns:carf="urn:oecd:ties:carf:v1" xmlns:stf="urn:oecd:ties:carfstf:v5" version="1.5">
  <carf:MessageSpec>
    <carf:TransmittingCountry>DE</carf:TransmittingCountry>
    <carf:ReceivingCountry>DE</carf:ReceivingCountry>
    <carf:MessageType>CARF</carf:MessageType>
    <carf:MessageRefId>DE2026DE0000000001</carf:MessageRefId>
    <carf:MessageTypeIndic>CARF701</carf:MessageTypeIndic>
    <carf:ReportingPeriod>2026-12-31</carf:ReportingPeriod>
    <carf:Timestamp>2027-07-15T09:30:00Z</carf:Timestamp>
  </carf:MessageSpec>
  <carf:CARFBody>
    <carf:RCASP>
      <carf:RCASP_ID>
        <carf:Entity>
          <carf:ResCountryCode>DE</carf:ResCountryCode>
          <carf:TIN issuedBy="DE">99/000/00000</carf:TIN>
          <carf:Name>Beispiel Krypto GmbH</carf:Name>
          <carf:Address>
            <carf:CountryCode>DE</carf:CountryCode>
            <carf:AddressFix>
              <carf:City>Frankfurt</carf:City>
            </carf:AddressFix>
          </carf:Address>
        </carf:Entity>
      </carf:RCASP_ID>
      <carf:Nexus>CARF901</carf:Nexus>
      <carf:DocSpec>
        <stf:DocTypeIndic>OECD1</stf:DocTypeIndic>
        <stf:DocRefId>DE2026DE-RCASP-0001</stf:DocRefId>
      </carf:DocSpec>
    </carf:RCASP>
    <carf:CryptoUsers>
      <carf:UserID>
        <carf:Individual>
          <carf:ResCountryCode>DE</carf:ResCountryCode>
          <carf:TIN issuedBy="DE">12345678901</carf:TIN>
          <carf:Name>
            <carf:FirstName>Anna</carf:FirstName>
            <carf:LastName>Beispiel</carf:LastName>
          </carf:Name>
          <carf:Address>
            <carf:CountryCode>DE</carf:CountryCode>
            <carf:AddressFix>
              <carf:City>Köln</carf:City>
            </carf:AddressFix>
          </carf:Address>
          <carf:BirthInfo>
            <carf:BirthDate>1990-05-04</carf:BirthDate>
          </carf:BirthInfo>
        </carf:Individual>
      </carf:UserID>
      <carf:RelevantTransactions>
        <carf:CryptoAsset>USDC</carf:CryptoAsset>
        <carf:CryptoTransferIn>
          <carf:TransferType>CARF506</carf:TransferType>
          <carf:NumberofTransactions>3</carf:NumberofTransactions>
          <carf:Amount currCode="EUR">15000.00</carf:Amount>
          <carf:NumberofUnits>15000.5</carf:NumberofUnits>
        </carf:CryptoTransferIn>
      </carf:RelevantTransactions>
      <carf:DocSpec>
        <stf:DocTypeIndic>OECD1</stf:DocTypeIndic>
        <stf:DocRefId>DE2026DE-USER-0001</stf:DocRefId>
      </carf:DocSpec>
    </carf:CryptoUsers>
  </carf:CARFBody>
</carf:CARF_OECD>`;

const codes = (xml: string) => validateCarf(xml).findings.map((f) => f.code);

test("a well-formed message passes with no errors", () => {
  const r = validateCarf(VALID);
  const errs = r.findings.filter((f) => f.severity === "error");
  assert.deepEqual(errs, [], `unexpected errors: ${JSON.stringify(errs, null, 1)}`);
  assert.equal(r.ok, true);
  assert.equal(r.summary.rcaspCount, 1);
  assert.equal(r.summary.userCount, 1);
  assert.equal(r.summary.messageTypeIndic, "CARF701");
  assert.equal(r.summary.isTestData, false);
});

test("namespace prefixes are ignored when matching", () => {
  // Drop the prefix from the tags and bind the same namespace as the default.
  // (A blanket replace of "carf:" would also mangle the namespace URI.)
  const noPrefix = VALID.replace(/<(\/?)carf:/g, "<$1").replace('xmlns:carf="', 'xmlns="');
  assert.equal(validateCarf(noPrefix).ok, true);
});

test("unbalanced XML is reported with a line number, not a crash", () => {
  const broken = VALID.replace("</carf:MessageSpec>", "");
  const r = validateCarf(broken);
  assert.equal(r.ok, false);
  assert.ok(["XML_MISMATCH", "XML_UNCLOSED"].includes(r.findings[0].code));
  assert.ok(r.findings[0].line > 0);
});

test("wrong root element is an error", () => {
  assert.ok(codes(VALID.replace(/CARF_OECD/g, "CRS_OECD")).includes("ROOT_NAME"));
});

test("missing MessageSpec elements are each reported", () => {
  const c = codes(VALID.replace(/\s*<carf:MessageType>CARF<\/carf:MessageType>/, ""));
  assert.ok(c.includes("MISSING_MESSAGETYPE"));
});

test("MessageType must be exactly CARF", () => {
  assert.ok(codes(VALID.replace(">CARF<", ">CRS<")).includes("MESSAGETYPE"));
});

test("unknown MessageTypeIndic is rejected", () => {
  assert.ok(codes(VALID.replace("CARF701", "CARF999")).includes("MESSAGETYPEINDIC"));
});

test("ReportingPeriod must be the last day of the period", () => {
  const c = codes(VALID.replace("2026-12-31", "2026-01-01"));
  assert.ok(c.includes("REPORTINGPERIOD_NOT_YEAR_END"));
});

test("malformed ReportingPeriod is an error not a warning", () => {
  const r = validateCarf(VALID.replace("2026-12-31", "31.12.2026"));
  assert.ok(r.findings.some((f) => f.code === "REPORTINGPERIOD_FORMAT" && f.severity === "error"));
});

test("bad Timestamp is caught", () => {
  assert.ok(codes(VALID.replace("2027-07-15T09:30:00Z", "2027-07-15 09:30")).includes("TIMESTAMP_FORMAT"));
});

test("country code must be two letters", () => {
  assert.ok(codes(VALID.replace(">DE</carf:TransmittingCountry>", ">GER</carf:TransmittingCountry>")).includes("COUNTRY_FORMAT"));
});

test("MessageRefId not starting with the sending country is flagged", () => {
  assert.ok(codes(VALID.replace("DE2026DE0000000001", "XX2026DE0000000001")).includes("MESSAGEREFID_PREFIX"));
});

test("CARF701 carrying corrections is an error", () => {
  const c = codes(VALID.replace("<stf:DocTypeIndic>OECD1</stf:DocTypeIndic>\n        <stf:DocRefId>DE2026DE-USER-0001", "<stf:DocTypeIndic>OECD2</stf:DocTypeIndic>\n        <stf:DocRefId>DE2026DE-USER-0001"));
  assert.ok(c.includes("NEW_WITH_CORRECTIONS"));
});

test("CARF702 carrying new data is an error", () => {
  assert.ok(codes(VALID.replace("CARF701", "CARF702")).includes("CORRECTION_WITH_NEW"));
});

test("duplicate DocRefId is caught with both line numbers", () => {
  const dup = VALID.replace("DE2026DE-USER-0001", "DE2026DE-RCASP-0001");
  const r = validateCarf(dup);
  const f = r.findings.find((x) => x.code === "DOCREFID_DUPLICATE");
  assert.ok(f, "expected a duplicate finding");
  assert.match(f!.message.en, /also on line \d+/);
  assert.match(f!.message.de, /auch in Zeile \d+/);
});

test("test data indicators are surfaced and mixing is an error", () => {
  const mixed = VALID.replace("<stf:DocTypeIndic>OECD1</stf:DocTypeIndic>\n        <stf:DocRefId>DE2026DE-RCASP-0001", "<stf:DocTypeIndic>OECD11</stf:DocTypeIndic>\n        <stf:DocRefId>DE2026DE-RCASP-0001");
  const c = codes(mixed);
  assert.ok(c.includes("TEST_PROD_MIX"));
  assert.ok(c.includes("TEST_DATA"));
});

test("nil report containing users is an error", () => {
  assert.ok(codes(VALID.replace("CARF701", "CARF703")).includes("NIL_WITH_USERS"));
});

test("Amount without currCode is an error", () => {
  assert.ok(codes(VALID.replace('<carf:Amount currCode="EUR">', "<carf:Amount>")).includes("AMOUNT_NO_CURRENCY"));
});

test("non-numeric Amount is an error", () => {
  assert.ok(codes(VALID.replace(">15000.00<", ">15.000,00<")).includes("AMOUNT_FORMAT"));
});

test("negative Amount is a warning", () => {
  const r = validateCarf(VALID.replace(">15000.00<", ">-15000.00<"));
  assert.ok(r.findings.some((f) => f.code === "AMOUNT_NEGATIVE" && f.severity === "warning"));
});

test("unknown TransferType is rejected", () => {
  assert.ok(codes(VALID.replace("CARF506", "CARF699")).includes("TRANSFERTYPE_VALUE"));
  // the outbound list must not be applied to an inbound transfer
  assert.ok(!codes(VALID).includes("TRANSFERTYPE_VALUE"));
  assert.ok(codes(VALID.replace("CARF506", "CARF601")).includes("TRANSFERTYPE_VALUE"));
});

test("unknown Nexus is rejected", () => {
  assert.ok(codes(VALID.replace("CARF901", "CARF908")).includes("NEXUS_VALUE"));
});

test("empty TIN is an error", () => {
  assert.ok(codes(VALID.replace(">12345678901<", "><")).includes("TIN_EMPTY"));
});

test("NOTIN with unknown=true is accepted, the product's own output for a missing TIN", () => {
  const xml = VALID.replace(/<carf:TIN([^>]*)>12345678901<\/carf:TIN>/, '<carf:TIN$1 unknown="true">NOTIN</carf:TIN>');
  assert.ok(xml.includes('unknown="true">NOTIN<'));
  const c = codes(xml);
  assert.ok(!c.includes("TIN_EMPTY"));
  assert.ok(!c.includes("TIN_UNKNOWN_VALUE"));
});

test("an empty TIN marked unknown is still an error and the hint names NOTIN", () => {
  const xml = VALID.replace(/<carf:TIN([^>]*)>12345678901<\/carf:TIN>/, '<carf:TIN$1 unknown="true"></carf:TIN>');
  assert.ok(codes(xml).includes("TIN_EMPTY"));
});

test("a TIN marked unknown must carry the value NOTIN", () => {
  const xml = VALID.replace(/<carf:TIN([^>]*)>12345678901<\/carf:TIN>/, '<carf:TIN$1 unknown="true">12345678901</carf:TIN>');
  assert.ok(codes(xml).includes("TIN_UNKNOWN_VALUE"));
});

test("no TIN anywhere is a warning when users are reported", () => {
  const c = codes(VALID.replace(/<carf:TIN[^>]*>[^<]*<\/carf:TIN>/g, ""));
  assert.ok(c.includes("NO_TINS"));
});

test("non-integer transaction count is an error", () => {
  assert.ok(codes(VALID.replace(">3</carf:NumberofTransactions>", ">3.5</carf:NumberofTransactions>")).includes("TXCOUNT_FORMAT"));
});

test("German conventions: pre-2026 period warns", () => {
  const c = codes(VALID.replace("2026-12-31", "2025-12-31").replace("DE2026DE", "DE2025DE"));
  assert.ok(c.includes("DE_PERIOD_EARLY"));
});

test("German conventions: non-DE receiver is informational", () => {
  const r = validateCarf(VALID.replace("<carf:ReceivingCountry>DE", "<carf:ReceivingCountry>FR"));
  assert.ok(r.findings.some((f) => f.code === "DE_DOMESTIC" && f.severity === "info"));
});

test("empty input does not throw", () => {
  const r = validateCarf("   ");
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].code, "EMPTY");
});

test("non-XML input does not throw", () => {
  const r = validateCarf("this is not xml at all");
  assert.equal(r.ok, false);
});

test("findings are sorted errors first, then by line", () => {
  const r = validateCarf(VALID.replace(">CARF<", ">CRS<").replace("2026-12-31", "2026-06-30"));
  const sev = r.findings.map((f) => f.severity);
  const firstWarn = sev.indexOf("warning");
  if (firstWarn > -1) assert.ok(!sev.slice(firstWarn).includes("error"));
});

test("parseXml records attributes and strips prefixes", () => {
  const { root } = parseXml('<a:Foo xmlns:a="x" version="1.5"><a:Bar>hi</a:Bar></a:Foo>');
  assert.equal(root!.name, "Foo");
  assert.equal(root!.attrs.version, "1.5");
  assert.equal(root!.children[0].text, "hi");
});

test("self-closing elements do not corrupt the stack", () => {
  const { root, error } = parseXml("<Foo><Bar/><Baz>x</Baz></Foo>");
  assert.equal(error, null);
  assert.equal(root!.children.length, 2);
  assert.equal(root!.children[1].text, "x");
});

test("comments and CDATA are skipped", () => {
  const { root, error } = parseXml("<Foo><!-- <Ghost> --><Bar>ok</Bar></Foo>");
  assert.equal(error, null);
  assert.equal(root!.children.length, 1);
});

// --- DIP envelope (dip.xsd v2, Datensatzbeschreibung 17.11.2025, KHB 2.4) ---

const PAYLOAD = VALID.replace(/^<\?xml[^>]*>\n/, "");
const wrap = (payload: string, opts: { env?: string; code?: string; version?: string; ns?: string; extraHeader?: string; refId?: string; pos?: string } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<dip xmlns="${opts.ns ?? "http://itzbund.de/ozg/bzst/post/dip/v2/"}" version="${opts.version ?? "2.0"}">
  <header environment="${opts.env ?? "PROD"}">
    <consignment>
      <customerIdentifier>
        <identityProvider>BZST-CERT</identityProvider>
        <identifier>BZ12345</identifier>
      </customerIdentifier>
      <creationTime>2027-07-15T09:30:00Z</creationTime>
      <transferticketId>tt-0001</transferticketId>${opts.refId ? `\n      <referenceId>${opts.refId}</referenceId>` : ""}
    </consignment>
    <application code="${opts.code ?? "CARF"}"/>${opts.extraHeader ?? ""}
  </header>
  <body>
    <consignmentItem consignmentItemPosition="${opts.pos ?? "0"}">
      <data>
${payload}
      </data>
    </consignmentItem>
  </body>
</dip>`;

const DELIVERY = wrap(PAYLOAD);

test("a well-formed DIP delivery passes and the payload is still checked", () => {
  const r = validateCarf(DELIVERY);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.summary.envelope?.version, "2.0");
  assert.equal(r.summary.envelope?.environment, "PROD");
  assert.equal(r.summary.envelope?.application, "CARF");
  assert.equal(r.summary.envelope?.transferticketId, "tt-0001");
  assert.equal(r.summary.rcaspCount, 1);
  assert.equal(r.summary.userCount, 1);
});

test("a bare CARF payload reports no envelope and behaves as before", () => {
  const r = validateCarf(VALID);
  assert.equal(r.summary.envelope, null);
  assert.equal(r.ok, true);
});

test("payload defects inside the envelope are reported with their own line numbers", () => {
  const r = validateCarf(wrap(PAYLOAD.replace("CARF701", "CARF999")));
  const f = r.findings.find((x) => x.code === "MESSAGETYPEINDIC");
  assert.ok(f);
  assert.ok(f!.line > 10, "line should point into the embedded payload");
});

test("wrong envelope namespace is an error", () => {
  assert.ok(codes(wrap(PAYLOAD, { ns: "http://itzbund.de/ozg/bzst/post/dip/v1/" })).includes("DIP_NAMESPACE"));
});

test("a prefixed envelope is accepted when the prefix is bound to the right namespace", () => {
  const prefixed = DELIVERY
    .replace('<dip xmlns="', '<dip:dip xmlns:dip="')
    .replace(/<(\/?)(header|consignment|customerIdentifier|identityProvider|identifier|creationTime|transferticketId|application|body|consignmentItem|data)\b/g, "<$1dip:$2")
    .replace("</dip>", "</dip:dip>");
  const r = validateCarf(prefixed);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test("envelope version other than 2.0 is an error", () => {
  assert.ok(codes(wrap(PAYLOAD, { version: "1.0" })).includes("DIP_VERSION"));
});

test("environment must be TEST or PROD", () => {
  assert.ok(codes(wrap(PAYLOAD, { env: "DEV" })).includes("DIP_ENVIRONMENT"));
});

test("application code must be CARF", () => {
  assert.ok(codes(wrap(PAYLOAD, { code: "DAC8" })).includes("DIP_APPLICATION_CODE"));
});

test("application placed in the body gets the specific finding", () => {
  const moved = DELIVERY.replace('    <application code="CARF"/>\n', "").replace("<body>", '<body>\n    <application code="CARF"/>');
  const c = codes(moved);
  assert.ok(c.includes("DIP_APPLICATION_PLACE"));
  assert.ok(c.includes("DIP_MISSING"));
});

test("unknown identityProvider is an error", () => {
  assert.ok(codes(DELIVERY.replace("BZST-CERT", "ELSTER-CERT")).includes("DIP_PROVIDER"));
});

test("identifier longer than 16 characters is an error", () => {
  assert.ok(codes(DELIVERY.replace("BZ12345", "BZ123456789012345678")).includes("DIP_LENGTH"));
});

test("creationTime must be an xs:dateTime", () => {
  assert.ok(codes(DELIVERY.replace("2027-07-15T09:30:00Z</creationTime>", "15.07.2027</creationTime>")).includes("DIP_CREATIONTIME"));
});

test("referenceId equal to the own transferticketId is an error", () => {
  assert.ok(codes(wrap(PAYLOAD, { refId: "tt-0001" })).includes("DIP_SELF_REFERENCE"));
  assert.ok(!codes(wrap(PAYLOAD, { refId: "tt-0000" })).includes("DIP_SELF_REFERENCE"));
});

test("wrong child order in the consignment is an error", () => {
  const swapped = DELIVERY.replace(
    "<creationTime>2027-07-15T09:30:00Z</creationTime>\n      <transferticketId>tt-0001</transferticketId>",
    "<transferticketId>tt-0001</transferticketId>\n      <creationTime>2027-07-15T09:30:00Z</creationTime>",
  );
  assert.ok(codes(swapped).includes("DIP_ORDER"));
});

test("an element the schema does not know is an error", () => {
  assert.ok(codes(wrap(PAYLOAD, { extraHeader: "\n    <comment>hello</comment>" })).includes("DIP_UNKNOWN_ELEMENT"));
});

test("more than one consignmentItem is an error for CARF", () => {
  const two = DELIVERY.replace("</consignmentItem>", '</consignmentItem>\n    <consignmentItem consignmentItemPosition="1"><data><x/></data></consignmentItem>');
  assert.ok(codes(two).includes("DIP_ONE_ITEM"));
});

test("consignmentItemPosition must be a non-negative integer, first one 0", () => {
  assert.ok(codes(wrap(PAYLOAD, { pos: "a" })).includes("DIP_POSITION"));
  const r = validateCarf(wrap(PAYLOAD, { pos: "42" }));
  assert.ok(r.findings.some((f) => f.code === "DIP_POSITION_FIRST" && f.severity === "warning"));
  assert.equal(r.ok, true);
});

test("data must contain exactly one CARF_OECD", () => {
  assert.ok(codes(wrap("<crs:CRS_OECD xmlns:crs=\"urn:oecd:ties:crs:v2\"/>")).includes("DIP_DATA_PAYLOAD"));
  assert.ok(codes(wrap("")).includes("DIP_DATA_PAYLOAD"));
});

test("PROD envelope with test DocTypeIndics is an error, TEST with production ones a warning", () => {
  const testData = PAYLOAD.replace(/OECD1</g, "OECD11<");
  assert.ok(codes(wrap(testData, { env: "PROD" })).includes("DIP_PROD_WITH_TESTDATA"));
  const r = validateCarf(wrap(PAYLOAD, { env: "TEST" }));
  assert.ok(r.findings.some((f) => f.code === "DIP_TEST_WITH_PRODDATA" && f.severity === "warning"));
  assert.equal(r.ok, true);
});

test("missing XML declaration is an error for a delivery and a warning for a bare payload", () => {
  const rd = validateCarf(DELIVERY.replace(/^<\?xml[^>]*>\n/, ""));
  assert.ok(rd.findings.some((f) => f.code === "DIP_NO_DECLARATION" && f.severity === "error"));
  const rb = validateCarf(VALID.replace(/^<\?xml[^>]*>\n/, ""));
  assert.ok(rb.findings.some((f) => f.code === "DIP_NO_DECLARATION" && f.severity === "warning"));
  assert.equal(rb.ok, true);
});

test("encoding must be spelled exactly UTF-8", () => {
  const r = validateCarf(DELIVERY.replace('encoding="UTF-8"', 'encoding="UTF8"'));
  assert.ok(r.findings.some((f) => f.code === "DIP_ENCODING" && f.severity === "error"));
  assert.ok(!codes(DELIVERY).includes("DIP_ENCODING"));
});

test("DocRefId not starting with country and period is a warning", () => {
  const r = validateCarf(VALID.replace("DE2026DE-USER-0001", "USER-0001"));
  assert.ok(r.findings.some((f) => f.code === "DOCREFID_PREFIX" && f.severity === "warning"));
  assert.ok(!codes(VALID).includes("DOCREFID_PREFIX"));
});

// --- schema shape and the generated filing ---

import { readFileSync } from "node:fs";

test("a filing generated by the Stablewerk engine passes and is counted correctly", () => {
  const xml = readFileSync(new URL("./fixtures/carf-generated.xml", import.meta.url), "utf-8");
  const r = validateCarf(xml);
  assert.equal(r.ok, true, JSON.stringify(r.findings.filter((f) => f.severity === "error")));
  assert.equal(r.summary.userCount, 2);
  assert.equal(r.summary.rcaspCount, 1);
  assert.equal(r.summary.transactionElements, 4);
  assert.equal(r.summary.envelope, null);
});

test("a user record without UserID or without transactions is an error", () => {
  const noId = VALID.replace(/<carf:UserID>[\s\S]*?<\/carf:UserID>\n/, "");
  assert.ok(codes(noId).includes("USER_NO_ID"));
  const noTx = VALID.replace(/<carf:RelevantTransactions>[\s\S]*?<\/carf:RelevantTransactions>\n/, "");
  assert.ok(codes(noTx).includes("USER_NO_TRANSACTIONS"));
});

test("two transaction kinds in one RelevantTransactions element is an error", () => {
  const mixed = VALID.replace(
    "        </carf:CryptoTransferIn>\n",
    "        </carf:CryptoTransferIn>\n        <carf:CryptoFiatOut>\n          <carf:NumberofTransactions>1</carf:NumberofTransactions>\n          <carf:Amount currCode=\"EUR\">10.00</carf:Amount>\n          <carf:NumberofUnits>10</carf:NumberofUnits>\n        </carf:CryptoFiatOut>\n",
  );
  assert.ok(codes(mixed).includes("RT_MIXED_KINDS"));
});

test("ExchangeType, AltValuation and CtrlgPersonType enumerations are checked", () => {
  const withAlt = VALID.replace("        </carf:CryptoTransferIn>", "          <carf:AltValuation>CARF1009</carf:AltValuation>\n        </carf:CryptoTransferIn>");
  assert.ok(codes(withAlt).includes("ALTVALUATION_VALUE"));
  const good = VALID.replace("        </carf:CryptoTransferIn>", "          <carf:AltValuation>CARF1002</carf:AltValuation>\n        </carf:CryptoTransferIn>");
  assert.ok(!codes(good).includes("ALTVALUATION_VALUE"));
});

// --- correction references ---

const CORRECTION = readFileSync(new URL("./fixtures/carf-correction.xml", import.meta.url), "utf-8");

test("a correction message generated by the Stablewerk engine passes", () => {
  const r = validateCarf(CORRECTION);
  assert.equal(r.ok, true, JSON.stringify(r.findings.filter((f) => f.severity === "error")));
  assert.equal(r.summary.messageTypeIndic, "CARF702");
  assert.deepEqual(r.summary.docTypeIndics, ["OECD0", "OECD2", "OECD3"]);
  assert.equal(r.summary.userCount, 2);
});

test("OECD2 and OECD3 without CorrDocRefId are errors", () => {
  const noRef = CORRECTION.replace(/\s*<stf:CorrDocRefId>[^<]*<\/stf:CorrDocRefId>/g, "");
  assert.equal(codes(noRef).filter((c) => c === "CORR_NO_REF").length, 2);
});

test("a correction without CorrMessageRefId is a warning, not an error", () => {
  const noMsg = CORRECTION.replace(/\s*<stf:CorrMessageRefId>[^<]*<\/stf:CorrMessageRefId>/g, "");
  const r = validateCarf(noMsg);
  assert.equal(r.ok, true);
  assert.equal(r.findings.filter((f) => f.code === "CORR_NO_MESSAGE_REF" && f.severity === "warning").length, 2);
});

test("CorrDocRefId equal to the own DocRefId is an error", () => {
  const same = CORRECTION.replace(
    /<stf:DocRefId>(DE2026C0001-U00001)<\/stf:DocRefId>\s*<stf:CorrMessageRefId>([^<]*)<\/stf:CorrMessageRefId>\s*<stf:CorrDocRefId>[^<]*<\/stf:CorrDocRefId>/,
    "<stf:DocRefId>$1</stf:DocRefId><stf:CorrMessageRefId>$2</stf:CorrMessageRefId><stf:CorrDocRefId>$1</stf:CorrDocRefId>",
  );
  assert.ok(codes(same).includes("CORR_SELF_REF"));
});

test("CorrMessageRefId equal to this message's own reference is an error", () => {
  const self = CORRECTION.replace(/<stf:CorrMessageRefId>[^<]*<\/stf:CorrMessageRefId>/, "<stf:CorrMessageRefId>DE2026DEC0001</stf:CorrMessageRefId>");
  assert.ok(codes(self).includes("CORR_MESSAGE_SELF"));
});

test("a new-data record carrying CorrDocRefId is an error", () => {
  const bad = VALID.replace("<stf:DocRefId>DE2026DE-USER-0001</stf:DocRefId>", "<stf:DocRefId>DE2026DE-USER-0001</stf:DocRefId>\n        <stf:CorrDocRefId>X</stf:CorrDocRefId>");
  assert.ok(codes(bad).includes("CORR_ON_NON_CORRECTION"));
});

test("deleting the RCASP while other user records stay is an error", () => {
  const bad = CORRECTION.replace(/(<carf:RCASP>[\s\S]*?)<stf:DocTypeIndic>OECD0<\/stf:DocTypeIndic>/, "$1<stf:DocTypeIndic>OECD3</stf:DocTypeIndic>");
  assert.ok(codes(bad).includes("RCASP_DELETE_WITH_USERS"));
  // all users deleted too: allowed
  const allDeleted = bad.replace(/<stf:DocTypeIndic>OECD2<\/stf:DocTypeIndic>/, "<stf:DocTypeIndic>OECD3</stf:DocTypeIndic>");
  assert.ok(!codes(allDeleted).includes("RCASP_DELETE_WITH_USERS"));
});

// --- generated DIP deliveries, signed and unsigned ---

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

test("deliveries generated by the Stablewerk engine pass: production, correction and synthetic test", () => {
  for (const [name, env, indics] of [
    ["dip-delivery.xml", "PROD", ["OECD1"]],
    ["dip-correction-delivery.xml", "PROD", ["OECD0", "OECD2", "OECD3"]],
    ["dip-test-delivery.xml", "TEST", ["OECD11"]],
  ] as const) {
    const r = validateCarf(fixture(name));
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.findings.filter((f) => f.severity === "error"))}`);
    assert.equal(r.summary.envelope?.environment, env, name);
    assert.equal(r.summary.envelope?.application, "CARF", name);
    assert.deepEqual(r.summary.docTypeIndics, indics, name);
    assert.equal(r.summary.envelope?.signed, false, name);
    assert.ok(r.findings.some((f) => f.code === "DIP_UNSIGNED"), name);
  }
});

test("a correction delivery's reference id is read and differs from its own ticket", () => {
  const r = validateCarf(fixture("dip-correction-delivery.xml"));
  assert.ok(r.summary.envelope?.referenceId);
  assert.notEqual(r.summary.envelope?.referenceId, r.summary.envelope?.transferticketId);
});

test("a signed delivery is accepted and reported as signed, not rejected as an unknown element", () => {
  const signed = fixture("dip-delivery.xml").replace(
    "</dip>",
    `  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    <SignedInfo>
      <CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
      <SignatureMethod Algorithm="http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1"/>
      <Reference URI="">
        <Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms>
        <DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
        <DigestValue>AAAA</DigestValue>
      </Reference>
    </SignedInfo>
    <SignatureValue>AAAA</SignatureValue>
  </Signature>
</dip>`,
  );
  const r = validateCarf(signed);
  assert.equal(r.ok, true, JSON.stringify(r.findings.filter((f) => f.severity === "error")));
  assert.equal(r.summary.envelope?.signed, true);
  assert.ok(r.findings.some((f) => f.code === "DIP_SIGNED"));
  assert.ok(!r.findings.some((f) => f.code === "DIP_UNKNOWN_ELEMENT"));
  assert.equal(r.summary.userCount, 2);
});

test("a signature placed before the body is out of order, and two signatures are too many", () => {
  const base = fixture("dip-delivery.xml");
  const sig = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>';
  assert.ok(codes(base.replace("<body>", `${sig}\n  <body>`)).includes("DIP_ORDER"));
  assert.ok(codes(base.replace("</dip>", `${sig}${sig}</dip>`)).includes("DIP_TOO_MANY"));
});

test("production data under a TEST envelope is still refused, and the synthetic test file is clean", () => {
  const bad = fixture("dip-delivery.xml").replace('environment="PROD"', 'environment="TEST"');
  assert.ok(codes(bad).includes("DIP_TEST_WITH_PRODDATA"));
  assert.ok(!codes(fixture("dip-test-delivery.xml")).some((c) => c.startsWith("DIP_") && c.endsWith("TESTDATA")));
});

test("OECD0 on a user record is an error; on the RCASP it is the normal resend", () => {
  assert.ok(!codes(CORRECTION).includes("OECD0_NOT_RCASP"));
  const bad = CORRECTION.replace(/<stf:DocTypeIndic>OECD2<\/stf:DocTypeIndic>/, "<stf:DocTypeIndic>OECD0</stf:DocTypeIndic>");
  assert.ok(codes(bad).includes("OECD0_NOT_RCASP"));
});


// --- schema conformance gaps found 24.11.2026 ---------------------------
//
// A file of real transfers, built by the engine and tampered with, passed this
// validator while the OECD schema (xmllint, CARFXML_v1.5.xsd) rejected it.
// Each case below is one such tampering; the schema rejects every one of them
// except the IdNr check digit, which is a typo warning.

const errCodes = (xml: string) =>
  validateCarf(xml).findings.filter((f) => f.severity === "error").map((f) => f.code);
const warnCodes = (xml: string) =>
  validateCarf(xml).findings.filter((f) => f.severity === "warning").map((f) => f.code);

test("a root in the wrong namespace is an error", () => {
  const v9 = VALID.replace('xmlns:carf="urn:oecd:ties:carf:v1"', 'xmlns:carf="urn:oecd:ties:carf:v9"');
  assert.ok(errCodes(v9).includes("ROOT_NAMESPACE"));
  const none = VALID.replace(/<(\/?)carf:/g, "<$1").replace(' xmlns:carf="urn:oecd:ties:carf:v1"', "");
  assert.ok(errCodes(none).includes("ROOT_NAMESPACE"));
  assert.ok(!errCodes(VALID).includes("ROOT_NAMESPACE"));
});

test("a country code outside the schema's list is an error wherever one is typed", () => {
  const inRes = VALID.replace("<carf:ResCountryCode>DE</carf:ResCountryCode>", "<carf:ResCountryCode>XX</carf:ResCountryCode>");
  assert.ok(errCodes(inRes).includes("COUNTRY_NOT_IN_SCHEMA"));
  const inAddr = VALID.replace("<carf:CountryCode>DE</carf:CountryCode>", "<carf:CountryCode>XX</carf:CountryCode>");
  assert.ok(errCodes(inAddr).includes("COUNTRY_NOT_IN_SCHEMA"));
  const inTx = VALID.replace("<carf:TransmittingCountry>DE", "<carf:TransmittingCountry>XX");
  assert.ok(errCodes(inTx).includes("COUNTRY_NOT_IN_SCHEMA"));
  const issuedBy = VALID.replace('issuedBy="DE"', 'issuedBy="XX"');
  assert.ok(errCodes(issuedBy).includes("COUNTRY_NOT_IN_SCHEMA"));
  const lower = VALID.replace("<carf:ResCountryCode>DE</carf:ResCountryCode>", "<carf:ResCountryCode>de</carf:ResCountryCode>");
  assert.ok(errCodes(lower).includes("COUNTRY_NOT_IN_SCHEMA"));
});

test("valid country codes the old short list lacked are not flagged", () => {
  for (const cc of ["VN", "NG", "KE", "PH"]) {
    const x = VALID.replace("<carf:ResCountryCode>DE</carf:ResCountryCode>", `<carf:ResCountryCode>${cc}</carf:ResCountryCode>`);
    assert.ok(!errCodes(x).includes("COUNTRY_NOT_IN_SCHEMA"), cc);
  }
});

test("a currency outside the schema's list is an error, a valid rare one is not", () => {
  assert.ok(errCodes(VALID.replace('currCode="EUR"', 'currCode="EUX"')).includes("CURRENCY_UNKNOWN"));
  assert.ok(errCodes(VALID.replace('currCode="EUR"', 'currCode="eur"')).includes("CURRENCY_UNKNOWN"));
  for (const cur of ["VND", "XAU", "USD"]) {
    assert.ok(!errCodes(VALID.replace('currCode="EUR"', `currCode="${cur}"`)).includes("CURRENCY_UNKNOWN"), cur);
  }
});

test("a person without any TIN is an error; NOTIN with unknown is the way out", () => {
  const noTin = VALID.replace(/<carf:TIN[^>]*>[^<]*<\/carf:TIN>\s*/, "");
  assert.ok(errCodes(noTin).includes("TIN_MISSING"));
  const notin = VALID.replace(/<carf:TIN[^>]*>[^<]*<\/carf:TIN>/, '<carf:TIN unknown="true">NOTIN</carf:TIN>');
  assert.ok(!errCodes(notin).includes("TIN_MISSING"));
  assert.ok(!errCodes(VALID).includes("TIN_MISSING"));
});

test("an organisation (Entity) without any TIN is an error too", () => {
  const entity =
    "<carf:Entity><carf:ResCountryCode>DE</carf:ResCountryCode><carf:Name>Beispiel GmbH</carf:Name></carf:Entity>";
  assert.ok(errCodes(VALID.replace("<carf:Nexus>", `${entity}<carf:Nexus>`)).includes("TIN_MISSING"));
  const withTin = entity.replace("<carf:Name>", '<carf:TIN issuedBy="DE">99/000/00000</carf:TIN><carf:Name>');
  assert.ok(!errCodes(VALID.replace("<carf:Nexus>", `${withTin}<carf:Nexus>`)).includes("TIN_MISSING"));
});

test("a birth date must be a real calendar day", () => {
  const bd = (v: string) => VALID.replace("1990-05-04", v);
  for (const bad of ["31.02.1980", "1980-02-31", "1900-02-29", "1990-13-01", "1990-5-4", "not a date", ""]) {
    assert.ok(errCodes(bd(bad)).includes("BIRTHDATE_INVALID"), JSON.stringify(bad));
  }
  for (const ok of ["1990-05-04", "2000-02-29", "1990-05-04Z", "1990-05-04+02:00"]) {
    assert.ok(!errCodes(bd(ok)).includes("BIRTHDATE_INVALID"), ok);
  }
  assert.ok(warnCodes(bd("1899-12-31")).includes("BIRTHDATE_RANGE"));
});

test("a German IdNr that fails its check digit is a warning, a valid one is not", () => {
  const idnr = (v: string) => VALID.replace("12345678901", v);
  assert.ok(warnCodes(idnr("47123456890")).includes("DE_IDNR_CHECKDIGIT"));
  assert.ok(!warnCodes(idnr("47123456899")).includes("DE_IDNR_CHECKDIGIT"));
  assert.ok(!errCodes(idnr("47123456890")).includes("DE_IDNR_CHECKDIGIT"));
  // a TIN issued elsewhere is not held to the German digit
  const foreign = idnr("47123456890").replace('issuedBy="DE">47123456890', 'issuedBy="FR">47123456890');
  assert.ok(!warnCodes(foreign).includes("DE_IDNR_CHECKDIGIT"));
});

test("the engine's own message, with real transfers, passes every new check", () => {
  // Stablewerk engine output validated against CARFXML_v1.5.xsd with xmllint;
  // here the same shape must give no error from the checks added above.
  const r = validateCarf(VALID);
  const added = ["ROOT_NAMESPACE", "COUNTRY_NOT_IN_SCHEMA", "CURRENCY_UNKNOWN", "TIN_MISSING", "BIRTHDATE_INVALID"];
  assert.deepEqual(r.findings.filter((f) => added.includes(f.code)), []);
});


// --- structure: what the schema says about order, counts and values ------
//
// A mutation sweep of the engine's own filing (every element deleted,
// duplicated, emptied, garbled, 343 files) found that half of what the OECD
// schema rejects passed this validator: a record missing its address, its
// name, its birth date, an amount. The checks below come from the schema's
// model (src/carf-schema.ts, generated from the OECD XSD).

const schemaErr = (xml: string) => errCodes(xml).filter((c) => c.startsWith("SCHEMA_"));

test("a required element missing deep inside a user record is an error", () => {
  for (const [what, xml] of [
    ["Address without CountryCode", VALID.replace("<carf:CountryCode>DE</carf:CountryCode>\n            <carf:AddressFix>", "<carf:AddressFix>")],
    ["Individual without Name", VALID.replace(/<carf:Name>[\s\S]*?<\/carf:Name>\s*/, "")],
    ["Name without FirstName", VALID.replace("<carf:FirstName>Anna</carf:FirstName>", "")],
    ["BirthInfo without BirthDate", VALID.replace("<carf:BirthDate>1990-05-04</carf:BirthDate>", "")],
    ["transfer without NumberofUnits", VALID.replace("<carf:NumberofUnits>15000.5</carf:NumberofUnits>", "")],
    ["transfer without Amount", VALID.replace('<carf:Amount currCode="EUR">15000.00</carf:Amount>', "")],
    ["user record without DocSpec", VALID.replace(/<carf:DocSpec>\s*<stf:DocTypeIndic>OECD1<\/stf:DocTypeIndic>\s*<stf:DocRefId>DE2026DE-USER-0001<\/stf:DocRefId>\s*<\/carf:DocSpec>/, "")],
  ] as const) {
    assert.notEqual(xml, VALID, what);
    assert.ok(errCodes(xml).length > 0, what);
  }
});

test("children in the wrong order or too many times are errors", () => {
  const swapped = VALID.replace(
    /(<carf:TIN issuedBy="DE">12345678901<\/carf:TIN>)(\s*)(<carf:Name>[\s\S]*?<\/carf:Name>)/,
    "$3$2$1",
  );
  assert.notEqual(swapped, VALID);
  assert.ok(schemaErr(swapped).includes("SCHEMA_UNEXPECTED"));
  const twice = VALID.replace("<carf:CountryCode>DE</carf:CountryCode>\n            <carf:AddressFix>", "<carf:CountryCode>DE</carf:CountryCode><carf:CountryCode>DE</carf:CountryCode>\n            <carf:AddressFix>");
  assert.ok(schemaErr(twice).includes("SCHEMA_UNEXPECTED"));
});

test("an element in the wrong namespace is an error", () => {
  const wrong = VALID.replace("<stf:DocTypeIndic>OECD1</stf:DocTypeIndic>", "<carf:DocTypeIndic>OECD1</carf:DocTypeIndic>");
  assert.notEqual(wrong, VALID);
  assert.ok(schemaErr(wrong).includes("SCHEMA_NAMESPACE"));
});

test("a value that breaks its type is an error: empty text, wrong date, wrong number", () => {
  for (const [what, xml] of [
    ["empty City", VALID.replace("<carf:City>Köln</carf:City>", "<carf:City></carf:City>")],
    ["NumberofUnits not a number", VALID.replace(">15000.5</carf:NumberofUnits>", ">lots</carf:NumberofUnits>")],
    ["Timestamp not a date and time", VALID.replace("2027-07-15T09:30:00Z", "15.07.2027")],
    ["empty ReportingPeriod", VALID.replace("<carf:ReportingPeriod>2026-12-31</carf:ReportingPeriod>", "<carf:ReportingPeriod></carf:ReportingPeriod>")],
  ] as const) {
    assert.notEqual(xml, VALID, what);
    assert.ok(errCodes(xml).length > 0, what);
  }
});

test("the repaired fixture raises no schema finding", () => {
  assert.deepEqual(schemaErr(VALID), []);
});

// The sweep: every leaf of the fixture deleted, doubled, emptied and garbled.
// Wherever the OECD schema (xmllint) rejects the file, so must this validator.
// Needs the schema files (schemas/, upstream, not committed) and xmllint;
// without them it is skipped, not failed.
const CARF_XSD = new URL("../schemas/CARFXML_v1.5.xsd", import.meta.url).pathname;
const hasSchema = spawnSync("xmllint", ["--version"]).status !== null && existsSync(CARF_XSD);

test(
  "sweep: nothing the OECD schema rejects is accepted here",
  { skip: !hasSchema && "OECD schema or xmllint not available (see schemas/README.md)" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "carf-sweep-"));
    try {
      const schemaOk = (xml: string) => {
        const f = join(dir, "m.xml");
        writeFileSync(f, xml);
        return spawnSync("xmllint", ["--noout", "--schema", CARF_XSD, f]).status === 0;
      };
      assert.ok(schemaOk(VALID), "the fixture itself must be schema-valid");
      const lines = VALID.split("\n");
      const misses: string[] = [];
      let tried = 0;
      lines.forEach((line, i) => {
        const m = /^(\s*)<([\w:]+)([^>]*)>([^<]*)<\/\2>\s*$/.exec(line);
        if (!m) return;
        const [, ind, tag, attrs, text] = m;
        const variants: [string, string[]][] = [
          ["delete", [""]],
          ["double", [line, line]],
          ["empty", [`${ind}<${tag}${attrs}></${tag}>`]],
          ["garble", [`${ind}<${tag}${attrs}>!!x!!</${tag}>`]],
        ];
        for (const [kind, repl] of variants) {
          if (kind === "empty" && !text) continue;
          const mutant = [...lines.slice(0, i), ...repl, ...lines.slice(i + 1)].join("\n");
          tried++;
          if (!schemaOk(mutant) && errCodes(mutant).length === 0) misses.push(`${kind} <${tag}> (line ${i + 1})`);
        }
      });
      assert.ok(tried > 100, `only ${tried} mutants generated`);
      assert.deepEqual(misses, [], `${misses.length} of ${tried} mutants rejected by the schema were accepted`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
