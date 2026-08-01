# DKIM keys

One directory per sending domain, named after the domain, containing:

    <domain>/
      selector   # e.g. "mk1"
      private    # PEM private key  — NEVER commit this
      public     # DNS TXT record value for <selector>._domainkey.<domain>

Generate with Haraka's dkim_key_gen.sh or:

    openssl genrsa -out private 2048
    openssl rsa -in private -pubout -out public

Key directories are git-ignored; only this README is committed.
