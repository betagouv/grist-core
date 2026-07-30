/**
 * Configuration for OpenID Connect (OIDC), useful for enterprise single-sign-on logins.
 * A good informative overview of OIDC is at https://developer.okta.com/blog/2019/10/21/illustrated-guide-to-oauth-and-oidc
 * Note:
 *    SP is "Service Provider", in our case, the Grist application.
 *    IdP is the "Identity Provider", somewhere users log into, e.g. Okta or Google Apps.
 *
 * We also use optional attributes for the user's name, for which we accept any of:
 *    given_name + family_name
 *    name
 *
 * Expected environment variables:
 *    env GRIST_OIDC_SP_HOST=https://<your-domain>
 *        Host at which our /oauth2 endpoint will live. Optional, defaults to `APP_HOME_URL`.
 *    env GRIST_OIDC_IDP_ISSUER
 *        The issuer URL for the IdP, passed to node-openid-client, see: https://github.com/panva/node-openid-client/blob/a84d022f195f82ca1c97f8f6b2567ebcef8738c3/docs/README.md#issuerdiscoverissuer.
 *        This variable turns on the OIDC login system.
 *    env GRIST_OIDC_IDP_CLIENT_ID
 *        The client ID for the application, as registered with the IdP.
 *    env GRIST_OIDC_IDP_CLIENT_SECRET
 *        The client secret for the application, as registered with the IdP.
 *    env GRIST_OIDC_IDP_SCOPES
 *        The scopes to request from the IdP, as a space-separated list. Defaults to "openid email profile".
 *    env GRIST_OIDC_SP_PROFILE_NAME_ATTR
 *        The key of the attribute to use for the user's name.
 *        If omitted, the name will either be the concatenation of "given_name" + "family_name" or the "name" attribute.
 *    env GRIST_OIDC_SP_PROFILE_EMAIL_ATTR
 *        The key of the attribute to use for the user's email. Defaults to "email".
 *    env GRIST_OIDC_IDP_END_SESSION_ENDPOINT
 *        If set, overrides the IdP's end_session_endpoint with an alternative URL to redirect user upon logout
 *        (for an IdP that has a logout endpoint but does not support the OIDC RP-Initiated Logout specification).
 *    env GRIST_OIDC_IDP_SKIP_END_SESSION_ENDPOINT
 *        If set to "true", on logout, there won't be any attempt to call the IdP's end_session_endpoint
 *        (the user will remain logged in in the IdP).
 *    env GRIST_OIDC_SP_IGNORE_EMAIL_VERIFIED
 *        If set to "true", the user will be allowed to login even if the email is not verified by the IDP.
 *        Defaults to false.
 *    env GRIST_OIDC_IDP_ENABLED_PROTECTIONS
 *        A comma-separated list of protections to enable. Supported values are "PKCE", "STATE", "NONCE"
 *        (or you may set it to "UNPROTECTED" alone, to disable any protections if you *really* know what you do!).
 *        Defaults to "PKCE,STATE", which is the recommended settings.
 *        It's highly recommended that you enable STATE, and at least one of PKCE or NONCE,
 *        depending on what your OIDC provider requires/supports.
 *    env GRIST_OIDC_IDP_ACR_VALUES
 *        A space-separated list of ACR values to request from the IdP. Optional.
 *    env GRIST_OIDC_IDP_EXTRA_CLIENT_METADATA
 *        A JSON object with extra client metadata to pass to openid-client. Optional.
 *        Be aware that setting this object may override any other values passed to the openid client.
 *        More info: https://github.com/panva/node-openid-client/tree/main/docs#new-clientmetadata-jwks-options
 *    env GRIST_OIDC_SP_HTTP_TIMEOUT
 *        The timeout in milliseconds for HTTP requests to the IdP. The default value is set to 3500 by the
 *        openid-client library. See: https://github.com/panva/node-openid-client/blob/main/docs/README.md#customizing-http-requests
 *    env GRIST_OIDC_SP_ENABLE_SILENT_LOGIN
 *        If set to "true", when an anonymous user visits a Grist page, Grist attempts a "silent login":
 *        an OIDC authentication request with prompt=none. If the user already has an active session
 *        at the IdP, they are logged into Grist without any interaction; otherwise they continue
 *        browsing anonymously (no error is shown). A failed attempt is remembered in a cookie for a
 *        few minutes, so anonymous visitors are not redirected on every page load.
 *        Defaults to false.
 *
 * This version of OIDCConfig has been tested with Keycloak OIDC IdP following the instructions
 * at:
 *   https://www.keycloak.org/getting-started/getting-started-docker
 *
 * /!\ CAUTION: For production, be sure to use https for all URLs. /!\
 *
 * For development of this module on localhost, these settings should work:
 *   - GRIST_OIDC_SP_HOST=http://localhost:8484 (or whatever port you use for Grist)
 *   - GRIST_OIDC_IDP_ISSUER=http://localhost:8080/realms/myrealm (replace 8080 by the port you use for keycloak)
 *   - GRIST_OIDC_IDP_CLIENT_ID=my_grist_instance
 *   - GRIST_OIDC_IDP_CLIENT_SECRET=YOUR_SECRET (as set in keycloak)
 *   - GRIST_OIDC_IDP_SCOPES="openid email profile"
 */

import { OIDC_PROVIDER_KEY } from "app/common/loginProviders";
import { UserProfile } from "app/common/LoginSessionAPI";
import { StringUnionError } from "app/common/StringUnion";
import { appSettings, AppSettings } from "app/server/lib/AppSettings";
import { RequestWithLogin, signInStatusCookieName } from "app/server/lib/Authorizer";
import { SessionObj } from "app/server/lib/BrowserSession";
import { GristLoginSystem, GristServer } from "app/server/lib/GristServer";
import { getHomeUrl } from "app/server/lib/gristSettings";
import log from "app/server/lib/log";
import { createLoginProviderFactory, NotConfiguredError } from "app/server/lib/loginSystemHelpers";
import { EnabledProtection, EnabledProtectionString, ProtectionsManager } from "app/server/lib/oidc/Protections";
import { agents } from "app/server/lib/ProxyAgent";
import { getOriginUrl } from "app/server/lib/requestUtils";
import { SendAppPageFunction } from "app/server/lib/sendAppPage";
import { Sessions } from "app/server/lib/Sessions";

import * as cookie from "cookie";
import * as express from "express";
import pick from "lodash/pick";
import {
  Client, ClientMetadata, custom, errors as OIDCError, Issuer, TokenSet, UserinfoResponse,
} from "openid-client";

// OIDC callback endpoint path.
const OIDC_CALLBACK_ENDPOINT = "/oauth2/callback";

// Endpoint initiating a silent login attempt (see GRIST_OIDC_SP_ENABLE_SILENT_LOGIN).
// It lives alongside the callback endpoint so that it is registered after the session
// middleware, which the wildcard middleware triggering it is not.
const OIDC_SILENT_LOGIN_ENDPOINT = "/oauth2/silent-login";

// Cookie marking that a silent login was recently attempted, to avoid redirecting anonymous
// visitors to the IdP on every page load.
const SILENT_LOGIN_ATTEMPTED_COOKIE = "grist_oidc_silent_login_attempted";

// How long to wait before retrying a silent login for the same browser.
const SILENT_LOGIN_RETRY_DELAY_MS = 5 * 60 * 1000;

// Error codes an IdP may return for a prompt=none request when interactive authentication
// is needed (OpenID Connect Core 1.0, section 3.1.2.6). These are the expected way for a
// silent login attempt to "fail" when the user has no active session at the IdP.
const SILENT_LOGIN_EXPECTED_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

function formatTokenForLogs(token: TokenSet) {
  const showValueInClear = ["token_type", "expires_in", "expires_at", "scope"];
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(token)) {
    if (typeof value !== "function") {
      result[key] = showValueInClear.includes(key) ? value : "REDACTED";
    }
  }
  return result;
}

class ErrorWithUserFriendlyMessage extends Error {
  constructor(errMessage: string, public readonly userFriendlyMessage: string) {
    super(errMessage);
  }
}

/**
 * Interface for OIDC configuration.
 */
export interface OIDCConfig {
  /**
   * Host at which our /oauth2 endpoint will live (e.g., https://your-domain.com).
   * Notice: that the configuration reader actually requires this to be set explicitly,
   * but the OIDCConfig interface allows it to be optional for other providers (like e.g., getgrist.com).
   */
  spHost?: string;
  /** The issuer URL for the IdP (Identity Provider). */
  readonly issuerUrl: string;
  /** The client ID for the application, as registered with the IdP. */
  readonly clientId: string;
  /** The client secret for the application, as registered with the IdP. */
  readonly clientSecret: string;
  /** The timeout in milliseconds for HTTP requests to the IdP. */
  readonly httpTimeout?: number;
  /** The key of the attribute to use for the user's name. If omitted, will use given_name + family_name or "name". */
  readonly namePropertyKey?: string;
  /** The key of the attribute to use for the user's email. */
  readonly emailPropertyKey: string;
  /** Alternative URL to redirect user upon logout (overrides the IdP's end_session_endpoint). */
  readonly endSessionEndpoint: string;
  /** If true, won't attempt to call the IdP's end_session_endpoint on logout. */
  readonly skipEndSessionEndpoint: boolean;
  /** A space-separated list of ACR (Authentication Context Class Reference) values to request from the IdP. */
  readonly acrValues?: string;
  /** If true, allows login even if the email is not verified by the IdP. */
  readonly ignoreEmailVerified: boolean;
  /** Extra client metadata to pass to openid-client. */
  readonly extraMetadata: Partial<ClientMetadata>;
  /** Set of enabled security protections (PKCE, STATE, NONCE). */
  readonly enabledProtections: Set<EnabledProtectionString>;
  /** The scopes to request from the IdP, as a space-separated list (e.g., "openid email profile"). */
  readonly scopes: string;
  /** If true, attempts to silently log in anonymous users using prompt=none. */
  readonly enableSilentLogin: boolean;
}

/**
 * Reads OIDC configuration from AppSettings into a JSON structure.
 * Structure follows what is defined in the app settings keys.
 */
export function readOIDCConfigFromSettings(settings: AppSettings): OIDCConfig {
  const section = settings.section("login").section("system").section(OIDC_PROVIDER_KEY);

  let issuerUrl = "";
  try {
    issuerUrl = section.flag("issuer").requireString({
      envVar: "GRIST_OIDC_IDP_ISSUER",
    });
  } catch (e) {
    throw new NotConfiguredError((e as Error).message);
  }

  const spHost = section.flag("spHost").requireString({
    envVar: "GRIST_OIDC_SP_HOST",
    defaultValue: getHomeUrl(),
  });

  const clientId = section.flag("clientId").requireString({
    envVar: "GRIST_OIDC_IDP_CLIENT_ID",
  });

  const clientSecret = section.flag("clientSecret").requireString({
    envVar: "GRIST_OIDC_IDP_CLIENT_SECRET",
    censor: true,
  });

  const httpTimeout = section.flag("httpTimeout").readInt({
    envVar: "GRIST_OIDC_SP_HTTP_TIMEOUT",
    minValue: 0, // 0 means no timeout
  });

  const namePropertyKey = section.flag("namePropertyKey").readString({
    envVar: "GRIST_OIDC_SP_PROFILE_NAME_ATTR",
  });

  const emailPropertyKey = section.flag("emailPropertyKey").requireString({
    envVar: "GRIST_OIDC_SP_PROFILE_EMAIL_ATTR",
    defaultValue: "email",
  });

  const endSessionEndpoint = section.flag("endSessionEndpoint").readString({
    envVar: "GRIST_OIDC_IDP_END_SESSION_ENDPOINT",
    defaultValue: "",
  })!;

  const skipEndSessionEndpoint = section.flag("skipEndSessionEndpoint").readBool({
    envVar: "GRIST_OIDC_IDP_SKIP_END_SESSION_ENDPOINT",
    defaultValue: false,
  })!;

  const acrValues = section.flag("acrValues").readString({
    envVar: "GRIST_OIDC_IDP_ACR_VALUES",
  })!;

  const ignoreEmailVerified = section.flag("ignoreEmailVerified").readBool({
    envVar: "GRIST_OIDC_SP_IGNORE_EMAIL_VERIFIED",
    defaultValue: false,
  })!;

  const extraMetadata = JSON.parse(section.flag("extraClientMetadata").readString({
    envVar: "GRIST_OIDC_IDP_EXTRA_CLIENT_METADATA",
  }) || "{}");

  const enabledProtections = buildEnabledProtections(section);

  const scopes = process.env.GRIST_OIDC_IDP_SCOPES || "openid email profile";

  const enableSilentLogin = section.flag("enableSilentLogin").readBool({
    envVar: "GRIST_OIDC_SP_ENABLE_SILENT_LOGIN",
    defaultValue: false,
  })!;

  return {
    spHost,
    issuerUrl,
    clientId,
    clientSecret,
    httpTimeout,
    namePropertyKey,
    emailPropertyKey,
    endSessionEndpoint,
    skipEndSessionEndpoint,
    acrValues,
    ignoreEmailVerified,
    extraMetadata,
    enabledProtections,
    scopes,
    enableSilentLogin,
  };
}

function buildEnabledProtections(section: AppSettings): Set<EnabledProtectionString> {
  const enabledProtections = section.flag("enabledProtections").readString({
    envVar: "GRIST_OIDC_IDP_ENABLED_PROTECTIONS",
    defaultValue: "PKCE,STATE",
  })!.split(",");
  if (enabledProtections.length === 1 && enabledProtections[0] === "UNPROTECTED") {
    log.warn("You chose to enable OIDC connection with no protection, you are exposed to vulnerabilities." +
      " Please never do that in production.");
    return new Set();
  }
  try {
    return new Set(EnabledProtection.checkAll(enabledProtections));
  } catch (e) {
    if (e instanceof StringUnionError) {
      throw new TypeError(`OIDC: Invalid protection in GRIST_OIDC_IDP_ENABLED_PROTECTIONS: ${e.actual}.` +
        ` Expected at least one of these values: "${e.values.join(",")}"`,
      );
    }
    throw e;
  }
}

export class OIDCBuilder {
  /**
   * Handy alias to create an OIDCBuilder instance and initialize it.
   */
  public static async build(
    sendAppPage: SendAppPageFunction,
    config?: OIDCConfig,
  ): Promise<OIDCBuilder> {
    const builder = new OIDCBuilder(sendAppPage, config);
    await builder.initOIDC();
    return builder;
  }

  protected _client: Client;
  private _config: OIDCConfig;
  private _redirectUrl: string | null;
  private _protectionManager: ProtectionsManager;

  constructor(
    private _sendAppPage: SendAppPageFunction,
    config?: OIDCConfig,
  ) {
    // Use provided config or read from global appSettings
    this._config = config ?? readOIDCConfigFromSettings(appSettings);
  }

  public async initOIDC(): Promise<void> {
    this._protectionManager = new ProtectionsManager(this._config.enabledProtections);

    this._redirectUrl = this._config.spHost ? new URL(OIDC_CALLBACK_ENDPOINT, this._config.spHost).href : null;
    custom.setHttpOptionsDefaults({
      ...(agents.trusted !== undefined ? { agent: agents.trusted } : {}),
      ...(this._config.httpTimeout !== undefined ? { timeout: this._config.httpTimeout } : {}),
    });
    await this._initClient({
      issuerUrl: this._config.issuerUrl,
      clientId: this._config.clientId,
      clientSecret: this._config.clientSecret,
      extraMetadata: this._config.extraMetadata,
    });

    if (this._client.issuer.metadata.end_session_endpoint === undefined &&
      !this._config.endSessionEndpoint && !this._config.skipEndSessionEndpoint) {
      throw new Error("The Identity provider does not propose end_session_endpoint. " +
        "If that is expected, please set GRIST_OIDC_IDP_SKIP_END_SESSION_ENDPOINT=true " +
        "or provide an alternative logout URL in GRIST_OIDC_IDP_END_SESSION_ENDPOINT");
    }
    log.info(`OIDCConfig: initialized with issuer ${this._config.issuerUrl}`);
  }

  public addEndpoints(app: express.Application, sessions: Sessions): void {
    app.get(OIDC_CALLBACK_ENDPOINT, this.handleCallback.bind(this, sessions));
    if (this._config.enableSilentLogin) {
      app.get(OIDC_SILENT_LOGIN_ENDPOINT, this.handleSilentLogin.bind(this));
    }
  }

  /**
   * Middleware that sends anonymous visitors through a silent login attempt (prompt=none).
   *
   * It runs before the session middleware, so it only relies on cookies: the sign-in status
   * cookie tells whether the user is already logged in, and a dedicated cookie remembers that
   * an attempt was made recently. The actual authentication URL is forged by the
   * /oauth2/silent-login endpoint, which does have access to the session.
   */
  public getSilentLoginMiddleware(): express.RequestHandler[] {
    if (!this._config.enableSilentLogin) { return []; }
    return [(req, res, next) => {
      if (!this._shouldAttemptSilentLogin(req)) { return next(); }
      const targetUrl = new URL(req.originalUrl, getOriginUrl(req)).href;
      res.redirect(`${OIDC_SILENT_LOGIN_ENDPOINT}?next=${encodeURIComponent(targetUrl)}`);
    }];
  }

  /**
   * Handles GET /oauth2/silent-login: stores the usual protections in the session and redirects
   * to the IdP with prompt=none. The IdP either sends the user back logged in, or with an error
   * such as login_required, which the callback turns into a plain redirect to the target page.
   */
  public async handleSilentLogin(req: express.Request, res: express.Response): Promise<void> {
    // Mark the attempt before anything else, so that a failed attempt is not retried on every
    // subsequent page load.
    res.cookie(SILENT_LOGIN_ATTEMPTED_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SILENT_LOGIN_RETRY_DELAY_MS,
    });
    const targetUrl = this._getSafeTargetUrl(req);
    try {
      const redirectUrl = await this.getSilentLoginRedirectUrl(req, targetUrl);
      res.redirect(redirectUrl);
    } catch (err) {
      log.warn(`OIDCConfig: failed to initiate silent login: ${err.message}`);
      res.redirect(targetUrl.href);
    }
  }

  public async handleCallback(sessions: Sessions, req: express.Request, res: express.Response): Promise<void> {
    let mreq;
    try {
      mreq = this._getRequestWithSession(req);
    } catch (err) {
      log.warn("OIDCConfig callback:", err.message);
      return this._sendErrorPage(req, res);
    }

    let targetUrl: string | undefined;
    const isSilentLoginAttempt = mreq.session.oidc?.silentLogin === true;

    try {
      const params = this._client.callbackParams(req);
      if (!mreq.session.oidc) {
        throw new Error("Missing OIDC information associated to this session");
      }

      targetUrl = mreq.session.oidc.targetUrl;

      const checks = this._protectionManager.getCallbackChecks(mreq.session.oidc);

      // The callback function will compare the protections present in the params and the ones we retrieved
      // from the session. If they don't match, it will throw an error.
      const tokenSet = await this._client.callback(this._redirectUrl ?? undefined, params, checks);
      log.debug("Got tokenSet: %o", formatTokenForLogs(tokenSet));

      const userInfo = await this._client.userinfo(tokenSet);
      log.debug("Got userinfo: %o", userInfo);

      if (!this._config.ignoreEmailVerified && userInfo.email_verified !== true) {
        throw new ErrorWithUserFriendlyMessage(
          `OIDCConfig: email not verified for ${userInfo.email}`,
          req.t("oidc.emailNotVerifiedError"),
        );
      }

      const profile = this._makeUserProfileFromUserInfo(userInfo);
      log.info(`OIDCConfig: got OIDC response for ${profile.email} (${profile.name}) redirecting to ${targetUrl}`);

      const scopedSession = sessions.getOrCreateSessionFromRequest(req);
      await scopedSession.operateOnScopedSession(req, async user => Object.assign(user, {
        profile,
      }));

      // We clear the previous session info, like the states, nonce or the code verifier, which
      // now that we are authenticated.
      // We store the idToken for later, especially for the logout
      mreq.session.oidc = {
        idToken: tokenSet.id_token,
      };
      res.redirect(targetUrl ?? "/");
    } catch (err) {
      if (isSilentLoginAttempt) {
        // The user never asked to log in, so any failure should quietly bring them back to the
        // page they wanted to visit, as an anonymous visitor. Errors like login_required are the
        // expected way for the IdP to report that no session is active there.
        if (this._isExpectedSilentLoginError(err)) {
          log.info(`OIDCConfig: silent login failed (${err.error}), continuing anonymously`);
        } else {
          log.warn(`OIDC silent login attempt failed: ${err.stack}`);
        }
        // Session deletion must be done before sending the response.
        delete mreq.session.oidc;
        return res.redirect(targetUrl ?? "/");
      }

      log.error(`OIDC callback failed: ${err.stack}`);
      const maybeResponse = this._maybeExtractDetailsFromError(err);
      if (maybeResponse) {
        log.error("Response received: %o",  maybeResponse);
      }

      // Delete entirely the session data when the login failed.
      // This way, we prevent several login attempts.
      //
      // Also session deletion must be done before sending the response.
      delete mreq.session.oidc;

      await this._sendErrorPage(req, res, err.userFriendlyMessage, targetUrl);
    }
  }

  public async getLoginRedirectUrl(req: express.Request, targetUrl: URL): Promise<string> {
    return this._buildAuthUrl(req, targetUrl);
  }

  /**
   * Like getLoginRedirectUrl(), but for a silent login attempt: asks the IdP not to prompt the
   * user (prompt=none), and marks the session so that the callback knows to quietly fall back
   * to anonymous browsing on failure.
   */
  public async getSilentLoginRedirectUrl(req: express.Request, targetUrl: URL): Promise<string> {
    return this._buildAuthUrl(req, targetUrl, { silent: true });
  }

  public async getLogoutRedirectUrl(req: express.Request, redirectUrl: URL): Promise<string> {
    // For IdPs that don't have end_session_endpoint, we just redirect to the requested page.
    if (this._config.skipEndSessionEndpoint) {
      return redirectUrl.href;
    }
    // Alternatively, we could use a logout URL specified by configuration.
    if (this._config.endSessionEndpoint) {
      return this._config.endSessionEndpoint;
    }
    // Ignore redirectUrl because OIDC providers don't allow variable redirect URIs
    const stableRedirectUri = new URL("/signed-out", getOriginUrl(req)).href;
    const session: SessionObj | undefined = (req as RequestWithLogin).session;
    return this._client.endSessionUrl({
      post_logout_redirect_uri: stableRedirectUri,
      id_token_hint: session?.oidc?.idToken,
    });
  }

  public supportsProtection(protection: EnabledProtectionString) {
    return this._protectionManager.supportsProtection(protection);
  }

  protected async _initClient({ issuerUrl, clientId, clientSecret, extraMetadata }:
  { issuerUrl: string, clientId: string, clientSecret: string, extraMetadata: Partial<ClientMetadata> },
  ): Promise<void> {
    try {
      const issuer = await Issuer.discover(issuerUrl);
      this._client = new issuer.Client({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: this._redirectUrl ? [this._redirectUrl] : undefined,
        response_types: ["code"],
        ...extraMetadata,
      });
    } catch (err) {
      log.error(`Failed to initialize OIDC client for issuer ${issuerUrl}: ${(err as Error).stack}`, err);
      throw new Error(
        `Failed to initialize OIDC client for issuer ${issuerUrl}: ${(err as Error).message}`,
      );
    }
  }

  private _sendErrorPage(
    req: express.Request,
    res: express.Response,
    userFriendlyMessage?: string,
    targetUrl?: string,
  ) {
    return this._sendAppPage(req, res, {
      path: "error.html",
      status: 500,
      config: {
        errPage: "signin-failed",
        errMessage: userFriendlyMessage,
        // Always set an errTargetUrl so that the browser isn't left on the callback URL.
        errTargetUrl: targetUrl ?? "/",
      },
    });
  }

  private async _buildAuthUrl(
    req: express.Request,
    targetUrl: URL,
    options: { silent?: boolean } = {},
  ): Promise<string> {
    const mreq = this._getRequestWithSession(req);

    mreq.session.oidc = {
      targetUrl: targetUrl.href,
      ...(options.silent ? { silentLogin: true } : {}),
      ...this._protectionManager.generateSessionInfo(),
    };

    return this._client.authorizationUrl({
      scope: this._config.scopes,
      acr_values: this._config.acrValues,
      ...(options.silent ? { prompt: "none" } : {}),
      ...this._protectionManager.forgeAuthUrlParams(mreq.session.oidc),
    });
  }

  private _shouldAttemptSilentLogin(req: express.Request): boolean {
    // Only trigger on page navigations, not on API calls or asset requests.
    if (req.method !== "GET") { return false; }
    if (!req.headers.accept?.includes("text/html")) { return false; }
    // Modern browsers tell us the destination of the request; only redirect top-level
    // navigations, so that embeds (iframes) are left alone.
    const fetchDest = req.headers["sec-fetch-dest"];
    if (fetchDest && fetchDest !== "document") { return false; }
    // Don't interfere with the login/logout flows themselves.
    if (this._isAuthPath(req.path)) { return false; }
    const cookies = cookie.parse(req.headers.cookie || "");
    // Skip users that are already signed in.
    if (cookies[signInStatusCookieName]) { return false; }
    // Skip browsers for which a silent login was attempted recently.
    if (cookies[SILENT_LOGIN_ATTEMPTED_COOKIE]) { return false; }
    return true;
  }

  private _isAuthPath(path: string): boolean {
    // Strip an /o/<org> prefix, present when the org is encoded in the path.
    const strippedPath = path.replace(/^\/o\/[^/]+/, "");
    return /^\/(oauth2\/|(login|signin|signup|logout|signed-out)\/?$)/.test(strippedPath);
  }

  /**
   * Returns the URL to send the user back to after a silent login attempt, based on the "next"
   * query parameter. Only same-origin URLs are allowed, to prevent open redirects.
   */
  private _getSafeTargetUrl(req: express.Request): URL {
    const origin = getOriginUrl(req);
    try {
      const next = typeof req.query.next === "string" ? req.query.next : "/";
      const url = new URL(next, origin);
      if (url.origin === new URL(origin).origin) { return url; }
    } catch (err) {
      // Fall through to the origin URL.
    }
    return new URL(origin);
  }

  private _isExpectedSilentLoginError(err: Error): err is OIDCError.OPError {
    return err instanceof OIDCError.OPError && !!err.error && SILENT_LOGIN_EXPECTED_ERRORS.has(err.error);
  }

  private _getRequestWithSession(req: express.Request) {
    const mreq = req as RequestWithLogin;
    if (!mreq.session) { throw new Error("no session available"); }

    return mreq;
  }

  private _makeUserProfileFromUserInfo(userInfo: UserinfoResponse): Partial<UserProfile> {
    return {
      email: String(userInfo[this._config.emailPropertyKey]),
      name: this._extractName(userInfo),
      // extra fields could be returned by the IdP that we might want to store
      extra: pick(userInfo, process.env.GRIST_IDP_EXTRA_PROPS?.split(",") || []),
    };
  }

  private _extractName(userInfo: UserinfoResponse): string | undefined {
    if (this._config.namePropertyKey) {
      return (userInfo[this._config.namePropertyKey] as any)?.toString();
    }
    const fname = userInfo.given_name ?? "";
    const lname = userInfo.family_name ?? "";

    return `${fname} ${lname}`.trim() || userInfo.name;
  }

  /**
   * Returns some response details from either OIDCClient's RPError or OPError,
   * which are handy for error logging.
   */
  private _maybeExtractDetailsFromError(error: Error) {
    if (error instanceof OIDCError.OPError || error instanceof OIDCError.RPError) {
      const { response } = error;
      if (response) {
        // Ensure that we don't log a buffer (which might be noisy), at least for now, unless we're sure that
        // would be relevant.
        const isBodyPureObject = response.body && Object.getPrototypeOf(response.body) === Object.prototype;
        return {
          body: isBodyPureObject ? response.body : undefined,
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
        };
      }
    }
    return null;
  }
}

/**
 * Get the OIDC login system.
 * This is the final method that ties everything together:
 * - Uses the config reader to read from AppSettings
 * - Passes the config to the builder
 * - Returns the login system
 */
async function getLoginSystem(settings: AppSettings): Promise<GristLoginSystem> {
  const config = readOIDCConfigFromSettings(settings);
  return {
    async getMiddleware(gristServer: GristServer) {
      // Build the middleware using the config
      const oidcBuilder = await OIDCBuilder.build(gristServer.sendAppPage.bind(gristServer), config);
      return {
        getLoginRedirectUrl: oidcBuilder.getLoginRedirectUrl.bind(oidcBuilder),
        getSignUpRedirectUrl: oidcBuilder.getLoginRedirectUrl.bind(oidcBuilder),
        getLogoutRedirectUrl: oidcBuilder.getLogoutRedirectUrl.bind(oidcBuilder),
        getWildcardMiddleware: oidcBuilder.getSilentLoginMiddleware.bind(oidcBuilder),
        async addEndpoints(app: express.Express) {
          oidcBuilder.addEndpoints(app, gristServer.getSessions());
          return OIDC_PROVIDER_KEY;
        },
      };
    },
    async deleteUser() { },
  };
}

export const getOIDCLoginSystem = createLoginProviderFactory(
  OIDC_PROVIDER_KEY,
  getLoginSystem,
);
