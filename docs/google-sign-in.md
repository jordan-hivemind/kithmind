# Google web sign-in

Google sign-in is an optional second way into an existing Kith Mind account. It
does not replace password sign-in or create Kith accounts. An existing user can
always sign in with the password once, open **Settings**, and choose **Connect
Google**. A deployment may also allow one operator-pinned organization user to
connect on the first Google sign-in, as described below. The selected Google
identity is stored in the existing `auth_accounts` table and future Google
sign-ins open the same Kith web session as password sign-in.

The linking callback requires the same live Kith session that started it and a
Google-signed token with a verified email. The email is provider metadata, not
the account key, and may differ from the password address. Later sign-in uses
Google's immutable `sub` claim. Explicit linking does not require the Google
email to equal the password address. Neither link path changes spaces or
memberships.

Organization auto-link is off by default. It requires all of these checks in
one transaction:

- Google's signed token says the email is verified.
- Its signed `hd` claim exactly equals the configured hosted domain.
- Lowercasing the complete email, without dot or plus-address rewriting,
  identifies exactly one existing Kith user.
- That user is the exact Kith user ID configured by the operator.
- The Google subject is not linked elsewhere and the Kith user has no different
  Google identity.

The user-ID pin is required because public password signup does not verify email
ownership. Without the pin, someone could register another person's address
first and retain password access after the address owner used Google sign-in.
Configure the ID only after confirming the established account through an
owner-controlled administrative context. Once linked, sign-in uses only the
Google subject; a later email or hosted-domain change does not move the link.

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

| Variable                        | Value                                                       |
| ------------------------------- | ----------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`        | The Web application client ID                               |
| `GOOGLE_OAUTH_CLIENT_SECRET`    | The Web application client secret                           |
| `GOOGLE_OAUTH_ORIGIN`           | The production HTTPS origin, with no path or trailing slash |
| `GOOGLE_OAUTH_HOSTED_DOMAIN`    | Optional canonical organization domain for safe auto-link   |
| `GOOGLE_OAUTH_AUTOLINK_USER_ID` | Optional existing Kith user ID eligible for auto-link       |

The first three values are optional as a group. If they are missing or invalid, the
Google sign-in and Settings controls are absent and the provider routes are
disabled. None uses a `NEXT_PUBLIC_` prefix. Keep the client secret in the
deployment's secret store and out of tracked files, logs, and shell history.
The last two values are an optional pair. If either is absent, first-sign-in
auto-link is disabled and explicit **Connect Google** remains available.

`GOOGLE_OAUTH_ORIGIN` pins the production callback. Production does not derive
it from the request host. In `next dev`, the callback uses the actual request
port only when the request origin is plain HTTP on exactly `localhost` or
`127.0.0.1` with an explicit port. Development preserves the validated
browser-visible loopback host, so a flow started on `127.0.0.1` also returns to
`127.0.0.1`; it never trusts a forwarded public host. Production ignores the
request host entirely.

The flow uses authorization code exchange with state, OpenID Connect nonce,
and PKCE S256. The callback verifies Google's RS256 signature, issuer,
audience, expiration, nonce, subject, and verified-email claim before reading
or writing a Kith provider account. See Google's
[OAuth 2.0 web-server guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [ID-token validation guide](https://developers.google.com/identity/sign-in/web/backend-auth).
