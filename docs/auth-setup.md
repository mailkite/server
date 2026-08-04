# Sign-in setup

A fresh install is deliberately open for exactly one moment: the first visitor claims it
(the WordPress pattern, see [`app-passwords.md`](app-passwords.md) for credential scope).
That moment must end. **Before the console is usable for anything else, the admin picks
how sign-in will be verified from then on — and the choice is only accepted once it has
been proven to work.**

## States

| State | Sign-in |
|---|---|
| **Unclaimed** (no admin, no `ADMIN_EMAIL`) | First email entered claims the install and is signed in directly. |
| **Claimed, setup incomplete** | The claiming session stays valid, but every screen is gated behind "Finish sign-in setup". No *new* session can be created by entering an email. |
| **Setup complete** | Only the chosen method authenticates. Direct sign-in is off permanently. |

The window where knowing the admin address is enough is therefore one session long, not
the life of the install.

## The two methods

### Email link
The admin supplies a send path, and the server proves it:

- **MailKite Cloud** — an `mk_live_` key (also gives the install real outbound via
  `SMARTHOST=cloud`), or
- **SMTP** — host, port, username, password, from-address; reuses the zero-dependency
  SMTP client already in `lib/smarthost.mjs`.

**Proof, not configuration.** The server sends a real verification mail containing a
one-time code to the admin address; setup completes only when that code is entered.
A key that 401s or an SMTP host that refuses AUTH can therefore never be saved as
"configured" — the failure that stranded us before is unrepresentable.

### OAuth (Google or GitHub)
Client id + secret + an allow-list of emails permitted to sign in. Completing one full
round trip *is* the proof: setup finishes only after the admin has actually signed in
through the provider and the returned email matches the allow-list.

## Failing closed, without bricking the box

Once setup is complete, a broken provider means no console sign-in — that is the correct
trade (an outage must never downgrade to "knows the admin address"). Box access remains
the root authority, exactly as with a lost admin:

```sh
node cli.mjs auth-status            # what's configured, when it was verified
node cli.mjs reset-auth             # clear the method, re-open setup, revoke sessions
node cli.mjs reset-admin <email>    # existing: reassign the admin
```

Anyone with shell on the server could read the database anyway, so shell access is the
recovery path — not a weaker network path.

## Environment still wins

`ADMIN_EMAIL`, `MAILKITE_SEND_KEY`, and OAuth credentials supplied as env vars are
honoured as pre-configuration: an install deployed by script starts in the correct state
with setup already satisfied for whatever was provided, and never shows the claim screen.
