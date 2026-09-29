// An OpenID Connect provider (Microsoft Entra ID, Keycloak, any other): the
// authorization code flow with PKCE, state and nonce, the ID token checked
// (issuer, audience, expiry, nonce), and its claims mapped into a principal.
// Entra leaves a user's groups out of the token when there are too many; then
// they come from Microsoft Graph (the app needs GroupMember.Read.All).

import * as oauth from "oauth4webapi";
import type { OidcProviderConfig } from "./config";
import { publicUrl, resolveValue } from "./config";
import { at, mapAttributes, strings, type Principal } from "./principal";
import type { TestStep } from "./ldap";

export interface OidcTokens {
  refreshToken?: string;
}

export class OidcProvider {
  private as?: oauth.AuthorizationServer;
  private client: oauth.Client;

  constructor(readonly cfg: OidcProviderConfig) {
    this.client = { client_id: cfg.clientId };
  }

  /** http:// issuers only in development (a local Keycloak) */
  private get insecure() {
    return this.cfg.issuer.startsWith("http://");
  }
  private opts<T extends object>(o: T = {} as T) {
    return this.insecure ? { ...o, [oauth.allowInsecureRequests]: true } : o;
  }

  private async server(): Promise<oauth.AuthorizationServer> {
    if (this.as) return this.as;
    const issuer = new URL(this.cfg.issuer);
    const res = await oauth.discoveryRequest(issuer, this.opts({ algorithm: "oidc" as const }));
    this.as = await oauth.processDiscoveryResponse(issuer, res);
    return this.as;
  }

  /** Check the settings before anyone signs in: the issuer's discovery document, what it offers, and
   *  that the client secret is there. (Signing in itself is the rest of the test.) */
  async test(origin: string): Promise<{ steps: TestStep[]; redirectUri: string }> {
    const steps: TestStep[] = [];
    const t = Date.now();
    try {
      this.as = undefined;
      const as = await this.server();
      steps.push({ ok: true, what: `Read ${this.cfg.issuer}/.well-known/openid-configuration`, detail: as.issuer, ms: Date.now() - t });
      const scopes = (as.scopes_supported as string[] | undefined) ?? [];
      const missing = (this.cfg.scopes ?? ["openid", "profile", "email"]).filter((s) => scopes.length && !scopes.includes(s) && !/^[\w.-]+\.\w+$|\//.test(s));
      steps.push({ ok: !!as.authorization_endpoint && !!as.token_endpoint, what: "Endpoints", detail: `sign-in ${as.authorization_endpoint ?? "missing"}, tokens ${as.token_endpoint ?? "missing"}` });
      if (missing.length) steps.push({ ok: false, what: "Scopes", detail: `not offered by the issuer: ${missing.join(", ")}` });
      if (this.cfg.groupsClaim && Array.isArray(as.claims_supported) && !(as.claims_supported as string[]).includes(this.cfg.groupsClaim))
        steps.push({ ok: true, what: "Groups", detail: `${this.cfg.groupsClaim} isn't listed among the issuer's claims: it may come from a mapper, or not at all` });
    } catch (e: any) {
      steps.push({ ok: false, what: `Read ${this.cfg.issuer}/.well-known/openid-configuration`, detail: String(e?.message ?? e), ms: Date.now() - t });
    }
    try {
      resolveValue(this.cfg.clientSecret);
      steps.push({ ok: !!this.cfg.clientSecret, what: "Client secret", detail: this.cfg.clientSecret ? (this.cfg.clientSecret.startsWith("env:") ? `from ${this.cfg.clientSecret.slice(4)}` : "stored") : "missing" });
    } catch (e: any) {
      steps.push({ ok: false, what: "Client secret", detail: e.message });
    }
    return { steps, redirectUri: this.redirectUri(origin) };
  }

  redirectUri(origin: string) {
    return `${publicUrl || origin}/api/auth/oidc/${encodeURIComponent(this.cfg.id)}/callback`;
  }

  /** Where to send the browser, and what to keep until it comes back. */
  async start(origin: string): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
    const as = await this.server();
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const url = new URL(as.authorization_endpoint!);
    url.searchParams.set("client_id", this.cfg.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri(origin));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (this.cfg.scopes ?? ["openid", "profile", "email", "offline_access"]).join(" "));
    url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    return { url: url.href, state, verifier, nonce };
  }

  /** The browser came back: the code for tokens, the tokens for a principal. */
  async finish(callback: URL, flow: { state: string; verifier: string; nonce: string }, origin: string): Promise<{ principal: Principal; tokens: OidcTokens }> {
    const as = await this.server();
    const auth = oauth.ClientSecretPost(resolveValue(this.cfg.clientSecret));
    const params = oauth.validateAuthResponse(as, this.client, callback, flow.state);
    const res = await oauth.authorizationCodeGrantRequest(as, this.client, auth, params, this.redirectUri(origin), flow.verifier, this.opts());
    const result = await oauth.processAuthorizationCodeResponse(as, this.client, res, { expectedNonce: flow.nonce, requireIdToken: true });
    const claims = oauth.getValidatedIdTokenClaims(result)!;
    return { principal: await this.principalOf(as, claims as Record<string, unknown>, result.access_token), tokens: { refreshToken: result.refresh_token } };
  }

  /** A session's refresh: new tokens, the claims read again. Throws when the provider says no. */
  async refresh(refreshToken: string): Promise<{ principal: Principal; tokens: OidcTokens }> {
    const as = await this.server();
    const auth = oauth.ClientSecretPost(resolveValue(this.cfg.clientSecret));
    const res = await oauth.refreshTokenGrantRequest(as, this.client, auth, refreshToken, this.opts());
    const result = await oauth.processRefreshTokenResponse(as, this.client, res);
    let claims = oauth.getValidatedIdTokenClaims(result) as Record<string, unknown> | undefined;
    // no new ID token: what the userinfo endpoint says
    if (!claims) claims = await this.userinfo(as, result.access_token, undefined);
    return { principal: await this.principalOf(as, claims, result.access_token), tokens: { refreshToken: result.refresh_token ?? refreshToken } };
  }

  private async userinfo(as: oauth.AuthorizationServer, accessToken: string, subject: string | undefined): Promise<Record<string, unknown>> {
    const res = await oauth.userInfoRequest(as, this.client, accessToken, this.opts());
    return (await oauth.processUserInfoResponse(as, this.client, subject ?? oauth.skipSubjectCheck, res)) as Record<string, unknown>;
  }

  private async principalOf(as: oauth.AuthorizationServer, idClaims: Record<string, unknown>, accessToken: string): Promise<Principal> {
    const c = this.cfg;
    let claims = idClaims;
    if (c.userinfo) claims = { ...claims, ...(await this.userinfo(as, accessToken, String(idClaims.sub))) };
    let groups = strings(at(claims, c.groupsClaim ?? "groups"));
    if (c.entraGraphOverage && isEntraOverage(claims)) groups = await entraGroups(accessToken);
    const subject = String(claims.sub);
    return {
      id: `${c.id}:${subject}`,
      provider: c.id,
      subject,
      username: strings(at(claims, c.usernameClaim ?? "preferred_username"))[0] ?? subject,
      email: strings(at(claims, c.emailClaim ?? "email"))[0],
      name: strings(at(claims, c.nameClaim ?? "name"))[0],
      groups: [...new Set(groups)].sort(),
      attrs: mapAttributes(claims, c.attributes),
    };
  }
}

/** Entra's "too many groups": the claim is replaced by a pointer (or hasgroups). */
export function isEntraOverage(claims: Record<string, unknown>): boolean {
  const names = claims._claim_names as Record<string, unknown> | undefined;
  return !!names?.groups || claims.hasgroups === true || claims.hasgroups === "true";
}

/** Every group (directly or through others) from Microsoft Graph: ids and display names. */
async function entraGroups(accessToken: string): Promise<string[]> {
  const out: string[] = [];
  let url: string | undefined = "https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.group?$select=id,displayName&$top=999";
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Microsoft Graph: ${res.status} reading the user's groups (the app needs GroupMember.Read.All).`);
    const page = (await res.json()) as { value: { id: string; displayName?: string }[]; "@odata.nextLink"?: string };
    for (const g of page.value) out.push(g.id, ...(g.displayName ? [g.displayName] : []));
    url = page["@odata.nextLink"];
  }
  return out;
}
