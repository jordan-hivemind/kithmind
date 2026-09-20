# Google web sign-in

Google sign-in is an optional second way into an existing Kith Mind account. It
does not replace password sign-in or create Kith accounts. Sign in with the
password once, open **Settings**, and choose **Connect Google**. The selected
Google identity is then stored in the existing `auth_accounts` table and future
Google sign-ins open the same Kith web session as password sign-in.

The linking callback requires the same live Kith session that started it and a
Google-signed token with a verified email. The email is provider metadata, not
the account key, and may differ from the password address. Later sign-in uses
Google's immutable `sub` claim. It never links or changes a Kith user from an
email match, and it does not change spaces or memberships.

## Google Cloud setup

In the [Google Cloud Console](https://console.cloud.google.com/), configure the
OAuth consent screen and create an OAuth 2.0 client with application type **Web
application**. Add every callback URI the deployment will use under **Authorized
redirect URIs**. Google requires an exact URI, including the port.

For production, add:

```text
https://your-kith-domain.example/api/auth/google/callback
```

For the common local development ports, add each URI separately:

```text
http://localhost:3000/api/auth/google/callback
http://localhost:3001/api/auth/google/callback
http://localhost:3002/api/auth/google/callback
```

If local development uses another port, register that exact URI too. If it uses
`127.0.0.1` instead of `localhost`, register the exact `127.0.0.1` URI. There is
no wildcard redirect, arbitrary-port proxy, or redirect broker.

Set these server-side variables in the web deployment:

| Variable                     | Value                                                       |
| ---------------------------- | ----------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`     | The Web application client ID                               |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The Web application client secret                           |
| `GOOGLE_OAUTH_ORIGIN`        | The production HTTPS origin, with no path or trailing slash |

The three values are optional as a group. If they are missing or invalid, the
Google sign-in and Settings controls are absent and the provider routes are
disabled. None uses a `NEXT_PUBLIC_` prefix. Keep the client secret in the
deployment's secret store and out of tracked files, logs, and shell history.

`GOOGLE_OAUTH_ORIGIN` pins the production callback. Production does not derive
it from the request host. In `next dev`, the callback uses the actual request
port only when the request origin is plain HTTP on exactly `localhost` or
`127.0.0.1` with an explicit port.

The flow uses authorization code exchange with state, OpenID Connect nonce,
and PKCE S256. The callback verifies Google's RS256 signature, issuer,
audience, expiration, nonce, subject, and verified-email claim before reading
or writing a Kith provider account. See Google's
[OAuth 2.0 web-server guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [ID-token validation guide](https://developers.google.com/identity/sign-in/web/backend-auth).
