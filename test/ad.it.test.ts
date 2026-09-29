// LDAPS against a real Active Directory (Samba AD DC; skipped unless
// QUERIER_IT_AD is its ldaps:// URL and QUERIER_IT_AD_CA its CA file; test/it/ad.sh makes one):
// domain corp.example.com, service account svc-querier, ana in finance-analysts
// (itself in finance), bob disabled.
import { expect, test } from "bun:test";
import { LdapProvider } from "../server/auth/ldap";

const URL_ = process.env.QUERIER_IT_AD;
const CA = process.env.QUERIER_IT_AD_CA;

const provider = (over: Record<string, unknown> = {}) =>
  new LdapProvider({
    id: "corp",
    type: "ldap",
    label: "Corporate AD",
    url: URL_!,
    caFile: CA,
    tlsServerName: "dc1.corp.example.com",
    bindDn: "CN=svc-querier,CN=Users,DC=corp,DC=example,DC=com",
    bindPassword: "Svc-Passw0rd!",
    baseDn: "DC=corp,DC=example,DC=com",
    groupBaseDn: "DC=corp,DC=example,DC=com",
    attributes: { department: "department" },
    ...over,
  });

test.skipIf(!URL_)("AD over LDAPS: bind, nested groups, attributes, lookup; wrong password, injection, disabled refused", async () => {
  const ad = provider();
  const ana = await ad.authenticate("ana", "Ana-Passw0rd!");
  expect(ana).toMatchObject({ provider: "corp", username: "ana", email: "ana@corp.example.com", attrs: { department: ["Finance"] } });
  // in finance-analysts, and through it in finance
  expect(ana.groups).toEqual(expect.arrayContaining(["finance", "finance-analysts"]));
  expect(ana.id).toMatch(/^corp:[0-9a-f]{8}-[0-9a-f]{4}-/); // objectGUID, as text
  expect(ana.ref).toBe("CN=Ana Lima,CN=Users,DC=corp,DC=example,DC=com");

  expect(ad.authenticate("ana", "wrong")).rejects.toThrow("wrong");
  expect(ad.authenticate("*", "Ana-Passw0rd!")).rejects.toThrow("wrong"); // a wildcard is a literal *
  expect(ad.authenticate("bob", "Bob-Passw0rd!")).rejects.toThrow(/disabled|wrong/);

  // a refresh: the person again by dn, with the service account only
  expect((await ad.lookup(ana.ref!))?.groups).toEqual(ana.groups);

  // the certificate is checked: another name doesn't match it
  expect(provider({ tlsServerName: "evil.example" }).authenticate("ana", "Ana-Passw0rd!")).rejects.toThrow();
  // without its CA, the self-signed certificate isn't trusted
  expect(provider({ caFile: undefined }).authenticate("ana", "Ana-Passw0rd!")).rejects.toThrow();
}, 30_000);

test.skipIf(!URL_)("the admin console's test: reach, bind, find a person by name without their password", async () => {
  const t = await provider().test("ana");
  expect(t.steps.every((s) => s.ok)).toBe(true);
  expect(t.principal?.groups).toEqual(expect.arrayContaining(["finance", "finance-analysts"]));
  expect(t.principal?.attrs.department).toEqual(["Finance"]);
  expect((await provider().test("bob")).disabled).toBe(true);
  expect((await provider().test("nobody-here")).steps.at(-1)).toMatchObject({ ok: false });
  const bad = await provider({ bindPassword: "wrong" }).test();
  expect(bad.steps.at(-1)).toMatchObject({ ok: false });
  expect(bad.steps.at(-1)!.what).toContain("sign in as");
}, 30_000);
