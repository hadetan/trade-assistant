import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface KiteMcpOAuthProviderOptions {
  loginPort: number;
  openExternal: (url: string) => void;
}

export class KiteMcpOAuthProvider implements OAuthClientProvider {
  private readonly loginPort: number;
  private readonly openExternalFn: (url: string) => void;

  private clientInformationValue?: OAuthClientInformationFull;
  private tokensValue?: OAuthTokens;
  private codeVerifierValue?: string;

  constructor(options: KiteMcpOAuthProviderOptions) {
    this.loginPort = options.loginPort;
    this.openExternalFn = options.openExternal;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.loginPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Trade Assistant",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.clientInformationValue;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.clientInformationValue = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokensValue;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.tokensValue = tokens;
  }

  saveCodeVerifier(verifier: string): void {
    this.codeVerifierValue = verifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error("codeVerifier requested before saveCodeVerifier — PKCE flow out of order");
    }
    return this.codeVerifierValue;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.openExternalFn(authorizationUrl.toString());
  }
}
